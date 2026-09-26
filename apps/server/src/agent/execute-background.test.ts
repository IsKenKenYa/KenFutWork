import { describe, expect, it } from "vitest";

import { createBackgroundTaskRegistry } from "./background-tasks.js";
import { createExecuteBackgroundTool } from "./execute-background.js";

function setup(overrides?: {
  execute?: (command: string) => Promise<{
    output: string;
    exitCode: number | null;
    truncated: boolean;
  }>;
}) {
  const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
  const calls: string[] = [];
  const backend = {
    execute: async (command: string) => {
      calls.push(command);
      return (
        overrides?.execute?.(command) ?? {
          output: "ok",
          exitCode: 0,
          truncated: false,
        }
      );
    },
  };
  const tool = createExecuteBackgroundTool({
    registry,
    backend,
    timeoutMs: 5_000,
  });
  return { registry, tool, calls };
}

describe("execute_background（DEC-15：长命令后台原语）", () => {
  it("立即返回 taskId；命令在后台跑完并落 completed 通知", async () => {
    const { registry, tool } = setup();

    const result = (await tool.invoke(
      { command: "pnpm test" },
      { configurable: {} },
    )) as string;
    expect(result).toMatch(/taskId=task_[a-z0-9]+/);

    await new Promise((r) => setTimeout(r, 0));
    expect(registry.hasPending()).toBe(false);
    const [notification] = registry.drainNotifications();
    expect(notification).toMatchObject({
      kind: "command",
      label: "pnpm test",
      status: "completed",
      summary: "ok",
    });
  });

  it("非零退出码：落 failed 且带 next_step 恢复指引", async () => {
    const { registry, tool } = setup({
      execute: async () => ({
        output: "2 tests failed",
        exitCode: 1,
        truncated: false,
      }),
    });
    await tool.invoke({ command: "pnpm test" }, { configurable: {} });
    await new Promise((r) => setTimeout(r, 0));

    const [notification] = registry.drainNotifications();
    expect(notification?.status).toBe("failed");
    expect(notification?.summary).toContain("2 tests failed");
    expect(notification?.nextStep).toContain("task_output");
  });

  it("超时：落 canceled，不再等命令自然结束", async () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 4 });
    const tool = createExecuteBackgroundTool({
      registry,
      backend: {
        execute: () => new Promise((resolve) => setTimeout(resolve, 60_000)),
      },
      timeoutMs: 1_000,
    });

    await tool.invoke({ command: "sleep 60" }, { configurable: {} });
    // timer 下限被钳到 1s；这里等到注册表出现终态为止（最多 ~1.5s）
    const deadline = Date.now() + 3_000;
    while (registry.hasPending() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(registry.hasPending()).toBe(false);
    const [notification] = registry.drainNotifications();
    expect(notification?.status).toBe("canceled");
  });

  it("并发闸门：注册表拒绝时命令不执行", async () => {
    const registry = createBackgroundTaskRegistry({ maxConcurrent: 1 });
    const calls: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<{
      output: string;
      exitCode: number;
      truncated: boolean;
    }>((resolve) => {
      releaseA = () => resolve({ output: "ok", exitCode: 0, truncated: false });
    });
    const tool = createExecuteBackgroundTool({
      registry,
      backend: {
        execute: async (command) => {
          calls.push(command);
          if (command === "a") return gateA;
          return { output: "ok", exitCode: 0, truncated: false };
        },
      },
      timeoutMs: 5_000,
    });

    await tool.invoke({ command: "a" }, { configurable: {} });
    const rejected = (await tool.invoke(
      { command: "b" },
      { configurable: {} },
    )) as string;

    expect(rejected).toContain("并发");
    releaseA();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["a"]);
  });
});
