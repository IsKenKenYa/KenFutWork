import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  type ComposeRun,
  createOpenDesignCompanionController,
  OPEN_DESIGN_COMPANION_ORIGIN,
  OPEN_DESIGN_COMPOSE_DOWN_TIMEOUT_MS,
  OPEN_DESIGN_COMPOSE_UP_TIMEOUT_MS,
  resolveOpenDesignCarrierMode,
} from "./companion.js";

/** 真实的临时 compose 路径（existsSync 走真文件系统，不 mock fs）。 */
const tempComposeFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "kfw-od-companion-"));
  const file = join(dir, "docker-compose.open-design.yml");
  writeFileSync(file, "name: test\n");
  return file;
};

describe("resolveOpenDesignCarrierMode（承载形态判定）", () => {
  it("未配置 / 空白 → none（不托管也不宣称外部）", () => {
    expect(resolveOpenDesignCarrierMode(undefined)).toBe("none");
    expect(resolveOpenDesignCarrierMode(null)).toBe("none");
    expect(resolveOpenDesignCarrierMode("   ")).toBe("none");
  });

  it("伴随 origin 的三种写法都认账（127.0.0.1 / localhost / ::1）", () => {
    expect(resolveOpenDesignCarrierMode("http://127.0.0.1:7456")).toBe(
      "managed",
    );
    expect(resolveOpenDesignCarrierMode("http://localhost:7456")).toBe(
      "managed",
    );
    expect(resolveOpenDesignCarrierMode("http://[::1]:7456")).toBe("managed");
  });

  it("外部地址一律不托管：https 反代 / 远端主机 / 非常规端口 / 坏 URL", () => {
    expect(resolveOpenDesignCarrierMode("https://od.example.com")).toBe(
      "external",
    );
    expect(resolveOpenDesignCarrierMode("http://10.0.0.9:7456")).toBe(
      "external",
    );
    expect(resolveOpenDesignCarrierMode("http://127.0.0.1:9999")).toBe(
      "external",
    );
    expect(resolveOpenDesignCarrierMode("not-a-url")).toBe("external");
  });

  it("伴随 origin 常量与 compose 发布端口一致（7456 两处同源）", () => {
    expect(OPEN_DESIGN_COMPANION_ORIGIN).toBe("http://127.0.0.1:7456");
  });
});

describe("伴随容器控制器（起停生命周期）", () => {
  it("启动成功：命令构造正确、幂等重放不再起第二次", async () => {
    const composeFile = tempComposeFile();
    const run = vi.fn<ComposeRun>(async () => ({ code: 0, stderr: "" }));
    const controller = createOpenDesignCompanionController({
      composeFile,
      apiToken: "paired-token",
      run,
    });

    await controller.start();
    expect(controller.snapshot().state).toBe("ready");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(["-f", composeFile, "up", "-d"]);

    // 幂等：ready 之后再 start 不重放（持久副作用红线）
    await controller.start();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("配了共享密钥 → 以 OD_API_TOKEN 注入 compose 进程环境", async () => {
    const run = vi.fn<ComposeRun>(async () => ({ code: 0, stderr: "" }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "paired-secret",
      run,
    });
    await controller.start();
    expect(run.mock.calls[0]?.[1]?.env).toEqual({
      OD_API_TOKEN: "paired-secret",
    });
  });

  it("未配密钥 → 照常起栈但注入空 OD_API_TOKEN（画布可用，凭证缝如实 503）", async () => {
    const run = vi.fn<ComposeRun>(async () => ({ code: 0, stderr: "" }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      run,
    });
    await controller.start();
    expect(controller.snapshot().state).toBe("ready");
    expect(run.mock.calls[0]?.[1]?.env).toEqual({ OD_API_TOKEN: "" });
  });

  it("compose 文件缺失 → 可读原因且一个 docker 命令都不发", async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: "" }));
    const controller = createOpenDesignCompanionController({
      composeFile: join(tmpdir(), "kfw-od-missing", "nope.yml"),
      apiToken: "paired-token",
      run,
    });
    await controller.start();
    expect(run).not.toHaveBeenCalled();
    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.error).toContain("找不到伴随容器 compose 文件");
  });

  it("up 失败：退出码 + stderr 首行进原因；多行尾噪与超长都被压掉", async () => {
    const run = vi.fn(async () => ({
      code: 125,
      stderr: `pull access denied for ghcr.io/nexu-io/od\n${"stack noise\n".repeat(50)}`,
    }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "paired-token",
      run,
    });
    await controller.start();
    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.error).toContain("退出码 125");
    expect(snapshot.error).toContain("pull access denied");
    expect(snapshot.error).not.toContain("stack noise");
    expect((snapshot.error ?? "").length).toBeLessThanOrEqual(240);
  });

  it("失败原因绝不带密钥明文（脱敏红线）", async () => {
    const run = vi.fn(async () => ({ code: 1, stderr: "boom" }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "super-secret-token",
      run,
    });
    await controller.start();
    const snapshot = controller.snapshot();
    expect(snapshot.error ?? "").not.toContain("super-secret-token");
  });

  it("docker 不在（ENOENT → 127）→ 原因可读，供 status 透出", async () => {
    const run = vi.fn(async () => ({
      code: 127,
      stderr: "spawn docker ENOENT",
    }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "paired-token",
      run,
    });
    await controller.start();
    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.error).toContain("退出码 127");
    expect(snapshot.error).toContain("ENOENT");
  });

  it("并发 start 共享同一次进行中的启动（同键重放只起一个栈）", async () => {
    let release:
      | ((value: { code: number; stderr: string }) => void)
      | undefined;
    const gate = new Promise<{ code: number; stderr: string }>((resolve) => {
      release = resolve;
    });
    const run = vi.fn<ComposeRun>(() => gate);
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "paired-token",
      run,
    });
    const first = controller.start();
    const second = controller.start();
    release?.({ code: 0, stderr: "" });
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().state).toBe("ready");
  });

  it("失败后允许下一次显式启动重试（不自动重试 ≠ 永远不再试）", async () => {
    const run = vi
      .fn<ComposeRun>()
      .mockResolvedValueOnce({ code: 1, stderr: "registry unreachable" })
      .mockResolvedValueOnce({ code: 0, stderr: "" });
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "paired-token",
      run,
    });
    await controller.start();
    expect(controller.snapshot().state).toBe("error");
    await controller.start();
    expect(controller.snapshot().state).toBe("ready");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("停止：down 带兜底超时；compose 资源缺失则不动 docker", async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: "" }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      run,
    });
    await controller.start();
    run.mockClear();
    await controller.stop();
    expect(run).toHaveBeenCalledWith(["-f", expect.any(String), "down"], {
      timeoutMs: OPEN_DESIGN_COMPOSE_DOWN_TIMEOUT_MS,
    });
    expect(controller.snapshot().state).toBe("idle");

    const missingRun = vi.fn(async () => ({ code: 0, stderr: "" }));
    const missing = createOpenDesignCompanionController({
      composeFile: join(tmpdir(), "kfw-od-missing", "nope.yml"),
      run: missingRun,
    });
    await missing.stop();
    expect(missingRun).not.toHaveBeenCalled();
  });

  it("从未启动也允许 stop（清理上次崩溃残留的半起状态；幂等）", async () => {
    const run = vi.fn(async () => ({ code: 0, stderr: "" }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      run,
    });
    await controller.stop();
    expect(run).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("停止失败不抛（dispose 不被 docker 报错卡死），只留 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn(async () => ({ code: 1, stderr: "docker daemon down" }));
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      run,
    });
    await expect(controller.stop()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("start 进行中被 stop：先等 up 落定再 down，不让两条命令打架", async () => {
    const order: string[] = [];
    let release:
      | ((value: { code: number; stderr: string }) => void)
      | undefined;
    const gate = new Promise<{ code: number; stderr: string }>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async (args: readonly string[]) => {
      order.push(args[2] ?? "");
      if (args[2] === "up") await gate;
      return { code: 0, stderr: "" };
    });
    const controller = createOpenDesignCompanionController({
      composeFile: tempComposeFile(),
      apiToken: "paired-token",
      run,
    });
    const starting = controller.start();
    const stopping = controller.stop();
    release?.({ code: 0, stderr: "" });
    await Promise.all([starting, stopping]);
    expect(order).toEqual(["up", "down"]);
  });

  it("超时有界：up 给足拉镜像时间、down 快速兜底", () => {
    expect(OPEN_DESIGN_COMPOSE_UP_TIMEOUT_MS).toBe(1_800_000);
    expect(OPEN_DESIGN_COMPOSE_DOWN_TIMEOUT_MS).toBeLessThan(
      OPEN_DESIGN_COMPOSE_UP_TIMEOUT_MS,
    );
  });
});
