import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CommandResult, RunCommand } from "../flow/engine/exec.js";
import {
  ensureHaConfigDir,
  HA_CONTAINER_NAME,
  HA_HOST_PORT,
  HA_IMAGE,
  haConfigurationYaml,
  haRunArguments,
  isHomeAssistantAnswering,
  planHaAutoProvision,
  provisionHomeAssistant,
} from "./stack.js";

/**
 * HA 自带实例的供给层：判据、命令形状、配置写入与幂等全部注入假执行器，
 * 真机「删干净后 HA 自己回来」那一段单独走人工验收，不用假桩冒充。
 */

function result(code: number, stdout = "", stderr = ""): CommandResult {
  return {
    code,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  };
}

/** 假 docker：按子命令给固定输出，并记下每次调用。 */
function fakeDocker(
  overrides: {
    ps?: CommandResult;
    version?: CommandResult;
    run?: CommandResult;
  } = {},
) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run: RunCommand = async (file, args) => {
    calls.push({ file, args });
    const sub = args[0];
    if (sub === "ps") return overrides.ps ?? result(0, "");
    if (sub === "version") return overrides.version ?? result(0, "29.6.2\n");
    if (sub === "run") return overrides.run ?? result(0, "container-id\n");
    return result(127, "", `unexpected docker ${String(sub)}`);
  };
  return { run, calls };
}

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL) => handler(String(input)));
}

describe("HA 自带实例的拉起判据", () => {
  it("桌面形态 + 运行时可用 + 没有 HA + 没有容器 → 拉起", () => {
    expect(
      planHaAutoProvision({
        desktop: true,
        carrierAvailable: true,
        managedContainerPresent: false,
        haAlreadyAnswering: false,
      }),
    ).toEqual({ action: "provision" });
  });

  it("8123 上已有 HA 就不新建：外部实例优先，且判据排在运行时之前", () => {
    expect(
      planHaAutoProvision({
        desktop: true,
        // 运行时不可用也不该改口：用户那台 HA 与本机 docker 状态无关
        carrierAvailable: false,
        managedContainerPresent: false,
        haAlreadyAnswering: true,
      }),
    ).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("沿用不新建"),
    });
  });

  it("我们自己的容器在应答时说「托管容器已在」，不许说成用户自建（真机踩过）", () => {
    expect(
      planHaAutoProvision({
        desktop: true,
        carrierAvailable: true,
        managedContainerPresent: true,
        // 重启后我们拉起的 HA 同样在 8123 应答，两个条件同时成立
        haAlreadyAnswering: true,
      }),
    ).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("托管容器已在"),
    });
  });

  it("非桌面形态绝不动用户的机器", () => {
    expect(
      planHaAutoProvision({
        desktop: false,
        carrierAvailable: true,
        managedContainerPresent: false,
        haAlreadyAnswering: false,
      }),
    ).toMatchObject({ action: "skip", reason: expect.stringContaining("非桌面") });
  });

  it("托管容器已在（含 Exited）→ 幂等跳过，不重复 docker run", () => {
    expect(
      planHaAutoProvision({
        desktop: true,
        carrierAvailable: true,
        managedContainerPresent: true,
        haAlreadyAnswering: false,
      }),
    ).toMatchObject({ action: "skip", reason: expect.stringContaining("不重复拉起") });
  });

  it("没有容器运行时时说清下一步做什么", () => {
    expect(
      planHaAutoProvision({
        desktop: true,
        carrierAvailable: false,
        managedContainerPresent: false,
        haAlreadyAnswering: false,
      }),
    ).toMatchObject({
      action: "skip",
      reason: expect.stringContaining("Docker Desktop"),
    });
  });
});

describe("HA 容器命令与配置", () => {
  it("docker run 参数：只绑回环、重启策略随机器回来、配置挂数据目录", () => {
    const args = haRunArguments("D:/data/homeassistant");
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(args).toEqual(
      expect.arrayContaining(["--name", HA_CONTAINER_NAME]),
    );
    expect(args).toEqual(expect.arrayContaining(["--restart", "unless-stopped"]));
    expect(args).toContain(`127.0.0.1:${HA_HOST_PORT}:${HA_HOST_PORT}`);
    expect(args).toContain("D:/data/homeassistant:/config");
    expect(args.at(-1)).toBe(HA_IMAGE);
  });

  it("配置同时满足面板内嵌与免登录签令牌两项前置条件", () => {
    const yaml = haConfigurationYaml();
    expect(yaml).toContain("use_x_frame_options: false");
    expect(yaml).toContain("trusted_networks:");
    expect(yaml).toContain("127.0.0.1");
    // 历史踩坑：宿主经 docker 网桥访问时来源 IP 不是回环
    expect(yaml).toContain("172.16.0.0/12");
  });

  it("configuration.yaml 首次写入，用户改过的不覆盖", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ha-stack-config-"));
    const file = join(dataDir, "homeassistant", "configuration.yaml");

    ensureHaConfigDir(dataDir);
    expect(readFileSync(file, "utf8")).toContain("use_x_frame_options");

    writeFileSync(file, "http:\n  # 用户自己改过\n", "utf8");
    ensureHaConfigDir(dataDir);
    expect(readFileSync(file, "utf8")).toContain("用户自己改过");
  });

  it("端口常量与插件 bundle 的 HA_LOOPBACK_BASE_URL 同值（两处各自声明，必须一起改）", () => {
    const bundle = readFileSync(
      join(
        process.cwd(),
        "..",
        "..",
        "plugins",
        "ha",
        "lib",
        "auto-init.js",
      ),
      "utf8",
    );
    expect(bundle).toContain(
      `HA_LOOPBACK_BASE_URL = "http://127.0.0.1:${HA_HOST_PORT}"`,
    );
  });
});

describe("HA 探活", () => {
  it("任何 HTTP 应答都算「有 HA」：401 是未授权 HA 的签名，404 说明端口已被占", async () => {
    for (const response of [
      Response.json({ message: "API running." }),
      new Response("401: Unauthorized", { status: 401 }),
      Response.json({}, { status: 404 }),
    ]) {
      await expect(
        isHomeAssistantAnswering({ fetchImpl: fakeFetch(() => response) }),
      ).resolves.toBe(true);
    }
  });

  it("连不上（ECONNREFUSED / 超时）按「没有 HA」处理，不抛错", async () => {
    await expect(
      isHomeAssistantAnswering({
        fetchImpl: fakeFetch(() => {
          throw new TypeError("fetch failed");
        }),
      }),
    ).resolves.toBe(false);
  });

  it("本机新拉的 HA 对 /api/ 回 401：判据必须认这个签名（真机实测）", async () => {
    // 未授权时 HA 的 /api/ 是 401 而非 200；按 2xx 判会把用户自建实例读成「没人」，
    // 接着去抢同一个端口，docker run 以 port is allocated 失败。
    await expect(
      isHomeAssistantAnswering({
        fetchImpl: fakeFetch(() =>
          Response.json(
            { message: "Unauthorized", error: "unauthorized" },
            { status: 401 },
          ),
        ),
      }),
    ).resolves.toBe(true);
  });
});

describe("HA 自带实例的拉起流程", () => {
  const dataDirOf = () => mkdtempSync(join(tmpdir(), "ha-stack-run-"));

  it("全绿时真的执行 docker run，并把配置目录挂进去", async () => {
    const dataDir = dataDirOf();
    const docker = fakeDocker();
    const outcome = await provisionHomeAssistant({
      dataDir,
      desktop: true,
      run: docker.run,
      fetchImpl: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(outcome.action).toBe("provisioned");
    const run = docker.calls.find((call) => call.args[0] === "run");
    expect(run?.args).toContain(`127.0.0.1:${HA_HOST_PORT}:${HA_HOST_PORT}`);
    expect(existsSync(join(dataDir, "homeassistant", "configuration.yaml"))).toBe(
      true,
    );
  });

  it("8123 已有 HA：跳过且不碰 docker run", async () => {
    const docker = fakeDocker();
    const outcome = await provisionHomeAssistant({
      dataDir: dataDirOf(),
      desktop: true,
      run: docker.run,
      fetchImpl: fakeFetch(() => Response.json({ message: "API running." })),
    });

    expect(outcome.action).toBe("skipped");
    expect(docker.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("托管容器已在：跳过（幂等，重启不重复拉起）", async () => {
    const docker = fakeDocker({ ps: result(0, `${HA_CONTAINER_NAME}\n`) });
    const outcome = await provisionHomeAssistant({
      dataDir: dataDirOf(),
      desktop: true,
      run: docker.run,
      fetchImpl: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(outcome.action).toBe("skipped");
    expect(docker.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  it("docker 守护进程不可达：跳过并说清启动什么", async () => {
    const docker = fakeDocker({
      version: result(1, "", "Cannot connect to the Docker daemon"),
    });
    const outcome = await provisionHomeAssistant({
      dataDir: dataDirOf(),
      desktop: true,
      run: docker.run,
      fetchImpl: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(outcome).toMatchObject({
      action: "skipped",
      reason: expect.stringContaining("容器运行时"),
    });
  });

  it("docker run 失败时给退出码与 stderr，不谎报已拉起", async () => {
    const docker = fakeDocker({
      run: result(125, "", "docker: Error response from daemon: port is allocated"),
    });
    const outcome = await provisionHomeAssistant({
      dataDir: dataDirOf(),
      desktop: true,
      run: docker.run,
      fetchImpl: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(outcome.action).toBe("failed");
    expect(outcome.reason).toContain("退出码 125");
    expect(outcome.reason).toContain("port is allocated");
    expect(outcome.command).toContain(HA_CONTAINER_NAME);
  });

  it("非桌面形态：即使 8123 上有 HA 也不建容器（enabled 门控之外的第二道闸）", async () => {
    const docker = fakeDocker();
    const outcome = await provisionHomeAssistant({
      dataDir: dataDirOf(),
      desktop: false,
      run: docker.run,
      fetchImpl: fakeFetch(() => Response.json({ message: "API running." })),
    });

    expect(outcome.action).toBe("skipped");
    expect(docker.calls.some((call) => call.args[0] === "run")).toBe(false);
  });
});
