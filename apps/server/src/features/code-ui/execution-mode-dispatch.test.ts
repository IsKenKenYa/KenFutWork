import { describe, expect, it, vi } from "vitest";
import {
  type ExecutionModeService,
  RetiredExecutionModeError,
} from "../agent-modes/execution-mode-service.js";
import { resolveCodeExecutionMode } from "./service.js";

function service(overrides: Partial<ExecutionModeService> = {}) {
  return {
    hydrate: vi.fn(async () => "agent" as const),
    getMode: vi.fn(() => "agent" as const),
    ...overrides,
  } as unknown as ExecutionModeService;
}

describe("resolveCodeExecutionMode（G2 执行模式回 Code 壳）", () => {
  it("无 agentModes 服务时返回 undefined，run 按默认模式走", async () => {
    expect(await resolveCodeExecutionMode(undefined, "t", "i")).toBeUndefined();
  });

  it("接纳前按 threadId+instanceId hydrate，返回持久化模式", async () => {
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

  it("hydrate失败可读拒绝接纳，不以旧缓存冻结另一种策略", async () => {
    const agentModes = service({
      hydrate: vi.fn(async () => {
        throw new Error("store down");
      }),
      getMode: vi.fn(() => "plan" as const),
    });
    await expect(
      resolveCodeExecutionMode(agentModes, "thread-1", "inst-1"),
    ).rejects.toThrow("无法读取工作方式");
    expect(agentModes.getMode).not.toHaveBeenCalled();
  });

  it("hydrate 判定旧 loop 模式退役时透出原因，不回落热缓存", async () => {
    const error = new RetiredExecutionModeError();
    const agentModes = service({
      hydrate: vi.fn(async () => {
        throw error;
      }),
      getMode: vi.fn(() => "plan" as const),
    });
    await expect(
      resolveCodeExecutionMode(agentModes, "thread-1", "inst-1"),
    ).rejects.toBe(error);
    expect(agentModes.getMode).not.toHaveBeenCalled();
  });
});
