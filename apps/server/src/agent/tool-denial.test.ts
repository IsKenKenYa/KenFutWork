import { describe, expect, it } from "vitest";

import {
  createToolDenialTracker,
  MAX_CONSECUTIVE_TOOL_DENIALS,
} from "./tool-denial.js";

/**
 * 回归：两条实测缺陷的记账侧。
 * 1. 被拒调用必须能被取出（运行时据此合成 tool.* 事件 → 界面上看得到「被拦」）；
 * 2. 同一工具连续被拒要有上限（否则模型反复重调 → 整轮 run 空转不结束）。
 */
describe("工具拒绝跟踪器", () => {
  const denial = (toolName: string, id = "call-1") => ({
    toolCallId: id,
    toolName,
    reason: "plan 计划模式：计划批准前仅允许只读工具",
  });

  it("记录被拒调用并带出参数与计数（供合成 tool.* 事件）", () => {
    const tracker = createToolDenialTracker();
    tracker.recordDenied({
      ...denial("write_file"),
      input: { file_path: "a.txt" },
    });

    const [record] = tracker.drain();
    expect(record).toMatchObject({
      toolCallId: "call-1",
      toolName: "write_file",
      count: 1,
      input: { file_path: "a.txt" },
    });
    // 取走后清空（同一批不会被下发两次）
    expect(tracker.drain()).toEqual([]);
  });

  it("连续被拒达上限才判致命；放行一次即清零", () => {
    const tracker = createToolDenialTracker();
    for (let i = 1; i < MAX_CONSECUTIVE_TOOL_DENIALS; i += 1) {
      tracker.recordDenied(denial("execute", `call-${i}`));
      expect(tracker.fatalReason()).toBeNull();
    }

    // 中途放行一次 → 连续计数清零，重新开始数
    tracker.recordAllowed("execute");
    tracker.recordDenied(denial("execute", "call-x"));
    expect(tracker.fatalReason()).toBeNull();

    tracker.recordDenied(denial("execute", "call-y"));
    tracker.recordDenied(denial("execute", "call-z"));
    const fatal = tracker.fatalReason();
    expect(fatal).toContain("execute");
    expect(fatal).toContain(`连续被拒绝 ${MAX_CONSECUTIVE_TOOL_DENIALS} 次`);
    expect(fatal).toContain("已中止本轮");
  });

  it("不同工具各自计数（一个工具触发上限不影响另一个）", () => {
    const tracker = createToolDenialTracker({ limit: 2 });
    tracker.recordDenied(denial("write_file", "a"));
    tracker.recordDenied(denial("execute", "b"));
    expect(tracker.fatalReason()).toBeNull();

    tracker.recordDenied(denial("execute", "c"));
    expect(tracker.fatalReason()).toContain("execute");
  });

  it("致命原因只记第一条（后续拒绝不覆盖最初的中止理由）", () => {
    const tracker = createToolDenialTracker({ limit: 1 });
    tracker.recordDenied(denial("a"));
    const first = tracker.fatalReason();
    tracker.recordDenied(denial("b"));
    expect(tracker.fatalReason()).toBe(first);
  });
});
