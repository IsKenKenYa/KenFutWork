import { describe, expect, it } from "vitest";

import { createAssistantBlockCollector } from "./assistant-block-collector.js";

/**
 * 服务端对话历史块组装器（content_blocks 持久化口径）的纯逻辑测试。
 *
 * 锁住的口径（2026-09-21 对话流/轨迹对齐 deepseek-harness 的存储改造）：
 * - 思考（thinking.delta）必须进历史——此前被静默丢弃，刷新后推理过程消失；
 * - 块上必须带 runId 与起止时刻——刷新后轨迹时间轴/耗时列才有数据；
 * - 「空轮次」判定只看可见内容：推理模型只输出思考的轮仍按空轮报失败。
 */

describe("createAssistantBlockCollector", () => {
  it("文本增量续写同一 text 块；工具打段后新起一段并打 at", () => {
    const collector = createAssistantBlockCollector();
    collector.onEvent({
      type: "message.delta",
      delta: "先说",
      timestamp: "2026-09-21T00:00:00.000Z",
    });
    collector.onEvent({ type: "message.delta", delta: "一半" });
    collector.onEvent({
      type: "tool.started",
      toolCallId: "t1",
      toolName: "read_file",
      runId: "run-1",
      timestamp: "2026-09-21T00:00:01.000Z",
    });
    collector.onEvent({
      type: "message.delta",
      delta: "再说",
      timestamp: "2026-09-21T00:00:02.000Z",
    });
    expect(collector.blocks).toEqual([
      { type: "text", text: "先说一半", at: "2026-09-21T00:00:00.000Z" },
      {
        type: "tool",
        toolCallId: "t1",
        toolName: "read_file",
        status: "running",
        runId: "run-1",
        startedAt: "2026-09-21T00:00:01.000Z",
      },
      { type: "text", text: "再说", at: "2026-09-21T00:00:02.000Z" },
    ]);
    expect(collector.text).toBe("先说一半再说");
  });

  it("思考增量并入 thinking 块并落库（此前被静默丢弃）", () => {
    const collector = createAssistantBlockCollector();
    collector.onEvent({
      type: "thinking.delta",
      delta: "想一想",
      timestamp: "2026-09-21T00:00:00.000Z",
    });
    collector.onEvent({ type: "thinking.delta", delta: "再想想" });
    collector.onEvent({ type: "message.delta", delta: "结论" });
    expect(collector.blocks).toEqual([
      expect.objectContaining({ type: "thinking", thinking: "想一想再想想" }),
      expect.objectContaining({ type: "text", text: "结论" }),
    ]);
    // 思考不进正文拼接：text 是纯结论口径
    expect(collector.text).toBe("结论");
  });

  it("tool.completed 就地收尾：输出/结论/产物/endedAt，runId 缺失时补上", () => {
    const collector = createAssistantBlockCollector();
    collector.onEvent({
      type: "tool.started",
      toolCallId: "t1",
      toolName: "generate_image",
    });
    collector.onEvent({
      type: "tool.completed",
      toolCallId: "t1",
      toolName: "generate_image",
      outputSummary: "好了",
      artifacts: [
        {
          type: "image",
          url: "https://example.com/a.png",
          mimeType: "image/png",
          width: 512,
          height: 512,
        },
      ],
      runId: "run-2",
      timestamp: "2026-09-21T00:00:03.000Z",
    });
    const block = collector.blocks[0];
    expect(block).toMatchObject({
      type: "tool",
      toolCallId: "t1",
      status: "completed",
      outputSummary: "好了",
      endedAt: "2026-09-21T00:00:03.000Z",
      runId: "run-2",
    });
    if (block?.type !== "tool") throw new Error("unreachable");
    expect(block.artifacts).toHaveLength(1);
  });

  it("重复的 tool.started（重放）不重复入块", () => {
    const collector = createAssistantBlockCollector();
    const event = {
      type: "tool.started" as const,
      toolCallId: "t1",
      toolName: "read_file",
    };
    collector.onEvent(event);
    collector.onEvent(event);
    expect(collector.blocks).toHaveLength(1);
  });

  it("空轮判定看可见内容：纯思考轮 hasVisibleContent=false，有正文/工具即 true", () => {
    const collector = createAssistantBlockCollector();
    collector.onEvent({ type: "thinking.delta", delta: "只有思考" });
    expect(collector.hasVisibleContent).toBe(false);
    collector.onEvent({
      type: "tool.started",
      toolCallId: "t1",
      toolName: "read_file",
    });
    expect(collector.hasVisibleContent).toBe(true);
  });

  it("reset 清空全部状态（重试换 run 用）", () => {
    const collector = createAssistantBlockCollector();
    collector.onEvent({ type: "message.delta", delta: "残句" });
    collector.onEvent({
      type: "tool.started",
      toolCallId: "t1",
      toolName: "read_file",
    });
    collector.reset();
    expect(collector.blocks).toHaveLength(0);
    expect(collector.text).toBe("");
    expect(collector.hasVisibleContent).toBe(false);
  });
});
