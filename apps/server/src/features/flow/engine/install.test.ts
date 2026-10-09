import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cancelEngineInstall,
  composeCommand,
  getEngineInstallSnapshot,
  purgeEngineStack,
  readStackRuntime,
  startEngineInstall,
  stopEngineStack,
  toWslPath,
  writeStackRuntime,
} from "./install.js";

/**
 * 引擎栈停止/卸载（FORM-11 生命周期）：
 *  - 默认 `down` 保数据卷；`deleteData` 才 `--volumes`（§9.1③ 显式选择才动数据）；
 *  - 失败原样给可读原因（退出码 + stderr 首行），不假装停止成功；
 *  - 取消安装是非安装态的幂等 no-op。
 *
 * 承载目标（双 Provider）：
 *  - `host` → `docker compose …`；`wsl2` → `wsl.exe -d <distro> -- docker compose …`
 *    （路径换 `/mnt/<盘>/…`）；
 *  - 安装时落盘承载记录，停止/查询读它（另一侧的 docker 找不到这套容器）；
 *  - 卸载 purge：`down --volumes --rmi all` + 清本地 env/日志/记录（插件代码保留）。
 */
function fakeRun(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  return {
    calls,
    run: async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return {
        code: result.code,
        stdout: Buffer.from(result.stdout ?? ""),
        stderr: Buffer.from(result.stderr ?? ""),
      };
    },
  };
}

function options() {
  const dataDir = mkdtempSync(join(tmpdir(), "flow-engine-stop-"));
  return { dataDir, composeFile: join(dataDir, "docker-compose.dify.yml") };
}

describe("引擎栈停止", () => {
  it("默认保留数据卷；deleteData 才追加 --volumes", async () => {
    const first = fakeRun({ code: 0 });
    const kept = await stopEngineStack(options(), { run: first.run });
    expect(kept.ok).toBe(true);
    expect(getEngineInstallSnapshot().state).toBe("idle");
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0]?.file).toBe("docker");
    const keptArgs = first.calls[0]?.args ?? [];
    expect(keptArgs).toContain("down");
    expect(keptArgs).toContain("dify");
    expect(keptArgs).toContain("--profile");
    expect(keptArgs).not.toContain("--volumes");

    const second = fakeRun({ code: 0 });
    const wiped = await stopEngineStack(
      { ...options(), deleteData: true },
      { run: second.run },
    );
    expect(wiped.ok).toBe(true);
    expect(second.calls[0]?.args).toContain("--volumes");
  });

  it("生成的 env 文件随数据目录走（down 与 up 同一份密钥口径）", async () => {
    const run = fakeRun({ code: 0 });
    const target = options();
    await stopEngineStack(target, { run: run.run });
    const envFile = join(target.dataDir, "dify-stack.env");
    expect(run.calls[0]?.args).toContain(envFile);
    expect(readFileSync(envFile, "utf8")).toContain("DIFY_ADMIN_API_KEY=");
  });

  it("down 失败原样给原因（退出码 + stderr 首行）", async () => {
    const run = fakeRun({ code: 1, stderr: "no such project\n其余噪音" });
    const result = await stopEngineStack(options(), { run: run.run });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("退出码 1");
    expect(result.error).toContain("no such project");
  });

  it("取消安装：非安装态是幂等 no-op（进行中杀子进程的路径由真机启停覆盖）", () => {
    expect(cancelEngineInstall().state).toBe("idle");
    expect(getEngineInstallSnapshot().state).toBe("idle");
  });
});

describe("引擎承载目标（双 Provider）", () => {
  it("toWslPath：盘符路径换 /mnt/<盘>/…；已是 POSIX 的原样", () => {
    expect(toWslPath("C:\\Users\\a\\b")).toBe("/mnt/c/Users/a/b");
    expect(toWslPath("D:/repo/dify/docker-compose.dify.yml")).toBe(
      "/mnt/d/repo/dify/docker-compose.dify.yml",
    );
    expect(toWslPath("/mnt/c/x")).toBe("/mnt/c/x");
  });

  it("composeCommand：host 走 docker；wsl2 走 wsl.exe 且 compose/env 路径换成 /mnt/…", () => {
    const host = composeCommand(
      { composeFile: "C:\\repo\\dify\\docker-compose.dify.yml", envFile: "C:\\data\\dify-stack.env" },
      ["--profile", "dify", "down"],
    );
    expect(host.command).toBe("docker");
    expect(host.args).toEqual([
      "compose",
      "--env-file",
      "C:\\data\\dify-stack.env",
      "-f",
      "C:\\repo\\dify\\docker-compose.dify.yml",
      "--profile",
      "dify",
      "down",
    ]);

    const wsl = composeCommand(
      {
        composeFile: "C:\\repo\\dify\\docker-compose.dify.yml",
        envFile: "C:\\data\\dify-stack.env",
        launch: { kind: "wsl2", distro: "Ubuntu" },
      },
      ["--profile", "dify", "down"],
    );
    expect(wsl.command).toBe("wsl.exe");
    expect(wsl.args.slice(0, 4)).toEqual(["-d", "Ubuntu", "--", "docker"]);
    expect(wsl.args).toContain("/mnt/c/data/dify-stack.env");
    expect(wsl.args).toContain("/mnt/c/repo/dify/docker-compose.dify.yml");
    // 不带 env 的只读查询路径：没有 --env-file（不创建密钥文件）
    const ps = composeCommand(
      { composeFile: "/x/docker-compose.dify.yml" },
      ["ps"],
    );
    expect(ps.args).not.toContain("--env-file");
  });

  it("承载记录：写读一致；无记录/坏文件回落 host（不猜）", () => {
    const { dataDir } = options();
    expect(readStackRuntime(dataDir)).toEqual({ kind: "host" });
    writeStackRuntime(dataDir, { kind: "wsl2", distro: "Ubuntu-24.04" });
    expect(readStackRuntime(dataDir)).toEqual({
      kind: "wsl2",
      distro: "Ubuntu-24.04",
    });
    writeFileSync(join(dataDir, "dify-stack.runtime.json"), "{ 坏 JSON");
    expect(readStackRuntime(dataDir)).toEqual({ kind: "host" });
  });

  it("WSL2 安装：命令经 wsl.exe，承载目标落盘（停止按同一目标执行）", () => {
    const { dataDir } = options();
    const composeFile = join(dataDir, "docker-compose.dify.yml");
    writeFileSync(composeFile, "services: {}\n");
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const fakeChild = {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      on: () => undefined,
      kill: () => undefined,
    };
    const { started } = startEngineInstall(
      { composeFile, dataDir, launch: { kind: "wsl2", distro: "Ubuntu" } },
      {
        spawn: ((command: string, args: readonly string[]) => {
          calls.push({ command, args });
          return fakeChild;
        }) as never,
      },
    );
    expect(started).toBe(true);
    expect(calls[0]?.command).toBe("wsl.exe");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["-d", "Ubuntu", "--", "docker"]);
    expect(calls[0]?.args).toContain("up");
    // 落盘：停止/查询都按它执行（否则 down 找不到另一侧起的容器）
    expect(readStackRuntime(dataDir)).toEqual({ kind: "wsl2", distro: "Ubuntu" });
    // 收尾：模块级安装态归零，不给后续用例留「installing」
    cancelEngineInstall();
    expect(getEngineInstallSnapshot().state).toBe("idle");
  });

  it("WSL2 停止：down 经同一承载目标（wsl.exe）", async () => {
    const target = options();
    const run = fakeRun({ code: 0 });
    const result = await stopEngineStack(
      { ...target, launch: { kind: "wsl2", distro: "Ubuntu" } },
      { run: run.run },
    );
    expect(result.ok).toBe(true);
    expect(run.calls[0]?.file).toBe("wsl.exe");
    expect(run.calls[0]?.args).toContain("Ubuntu");
    expect(run.calls[0]?.args).toContain("down");
  });

  it("卸载 purge：down --volumes --rmi all，并清掉本地 env/日志/承载记录", async () => {
    const target = options();
    writeFileSync(target.composeFile, "services: {}\n");
    writeStackRuntime(target.dataDir, { kind: "host" });
    const run = fakeRun({ code: 0 });
    const result = await purgeEngineStack(target, { run: run.run });
    expect(result.ok).toBe(true);
    const args = run.calls[0]?.args ?? [];
    expect(args).toContain("down");
    expect(args).toContain("--volumes");
    expect(args).toContain("--rmi");
    expect(args).toContain("all");
    // 本地产物清掉（下次安装重新生成）；compose 文件与插件代码不动
    expect(readStackRuntime(target.dataDir)).toEqual({ kind: "host" });
    expect(() =>
      readFileSync(join(target.dataDir, "dify-stack.env"), "utf8"),
    ).toThrow();
    expect(() =>
      readFileSync(join(target.dataDir, "dify-stack.runtime.json"), "utf8"),
    ).toThrow();
  });

  it("卸载 purge：从未安装（无 env/记录）不碰 docker，直接成功", async () => {
    const target = options();
    const run = fakeRun({ code: 0 });
    const result = await purgeEngineStack(target, { run: run.run });
    expect(result.ok).toBe(true);
    expect(run.calls).toHaveLength(0);
  });

  it("卸载 purge：down 失败原样给原因（不静默吞掉，也不清本地产物）", async () => {
    const target = options();
    writeFileSync(target.composeFile, "services: {}\n");
    writeStackRuntime(target.dataDir, { kind: "host" });
    const run = fakeRun({ code: 1, stderr: "daemon not running\n其余" });
    const result = await purgeEngineStack(target, { run: run.run });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("daemon not running");
    // 失败保留记录（用户可重试；否则下次会按 host 去清 WSL2 起的栈）
    expect(readStackRuntime(target.dataDir)).toEqual({ kind: "host" });
  });
});
