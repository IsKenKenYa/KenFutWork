import { describe, expect, it, vi } from "vitest";
import type { ExecutionModeService } from "../agent-modes/execution-mode-service.js";
import { resolveCodeExecutionMode } from "./service.js";

function service(overrides: Partial<ExecutionModeService> = {}) {
  return {
    hydrate: vi.fn(async () => "agent" as const),
    getMode: vi.fn(() => "agent" as const),
    ...overrides,
  } as unknown as ExecutionModeService;
}

describe("resolveCodeExecutionMode（G2 六档回 Code 壳）", () => {
  it("无 agentModes 服务时返回 undefined，run 按默认模式走", async () => {
    expect(await resolveCodeExecutionMode(undefined, "t", "i")).toBeUndefined();
  });

  it("派发前按 threadId+instanceId hydrate，返回持久化模式", async () => {
    const agentModes = service({
      hydrate: vi.fn(async () => "plan" as const),
    });
    await expect(
      resolveCodeExecutionMode(agentModes, "thread-1", "inst-1"),
    ).resolves.toBe("plan");
    expect(agentModes.hydrate).toHaveBeenCalledWith("thread-1", {
      instanceId: "inst-1",
    });
  });

  it("hydrate 抛错回落缓存现值，模式存储故障不挡 run", async () => {
    const agentModes = service({
      hydrate: vi.fn(async () => {
        throw new Error("store down");
      }),
      getMode: vi.fn(() => "loop" as const),
    });
    await expect(
      resolveCodeExecutionMode(agentModes, "thread-1", "inst-1"),
    ).resolves.toBe("loop");
  });
});
