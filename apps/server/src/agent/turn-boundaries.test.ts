import { describe, expect, it, vi } from "vitest";

import { captureAgentTurnBoundaryFacts } from "./turn-boundaries.js";

/**
 * 轮次边界的文件捕获契约（自动备份开关依赖它）。
 *
 * 设置 → 权限 → 自动备份关闭时，`agent-runs` 插件让 `beforeTurn` 返回 `undefined`。
 * 这条契约必须成立：**没有 capture 就把边界记成 not_supported**，而不是伪造一个
 * `captured` 加空引用——否则检查点时间线会显示「已备份」而实际没有快照。
 */
describe("轮次边界文件捕获", () => {
  it("hook 返回 undefined（自动备份关闭）→ not_supported，且不出 captured", async () => {
    const captureFiles = vi.fn(async () => undefined);
    const facts = await captureAgentTurnBoundaryFacts({
      captureFiles: captureFiles as never,
    });
    expect(captureFiles).toHaveBeenCalledTimes(1);
    expect(facts.files).toEqual({
      status: "unavailable",
      reason: "not_supported",
    });
  });

  it("hook 未装配 → not_supported，且不调用任何东西", async () => {
    const facts = await captureAgentTurnBoundaryFacts({});
    expect(facts.files).toEqual({
      status: "unavailable",
      reason: "not_supported",
    });
  });

  it("hook 返回 capture → captured 并带上 effective 引用", async () => {
    const facts = await captureAgentTurnBoundaryFacts({
      captureFiles: async () =>
        ({
          phase: "pre",
          created: { id: "cp-1" },
          effective: { id: "cp-1" },
        }) as never,
    });
    expect(facts.files).toEqual({ status: "captured", reference: "cp-1" });
  });

  it("capture 存在但 effective 为 null → captured + reference null（有效引用确实没有）", async () => {
    const facts = await captureAgentTurnBoundaryFacts({
      captureFiles: async () =>
        ({ phase: "pre", created: { id: "cp-2" }, effective: null }) as never,
    });
    expect(facts.files).toEqual({ status: "captured", reference: null });
  });

  it("hook 抛错 → failed（不伪装成 not_supported）", async () => {
    const facts = await captureAgentTurnBoundaryFacts({
      captureFiles: async () => {
        throw new Error("git 快照失败");
      },
    });
    expect(facts.files).toEqual({ status: "failed", reason: "capture_failed" });
  });
});
