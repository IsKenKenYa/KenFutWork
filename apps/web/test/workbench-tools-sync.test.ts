import { describe, expect, it } from "vitest";

import { serverBlocksToTaskBlocks } from "../src/lib/workbench-tools";

/**
 * 服务端 contentBlocks → 本地 TaskMessageBlock 的转换（B4 对账的底座）。
 * 反例都来自真机：本地任务仓里 assistant 段落是空的、服务端 `chat_messages` 有真序内容。
 */
describe("serverBlocksToTaskBlocks", () => {
  it("文本 / 思考 / 工具按真序映射，ISO 时间转毫秒", () => {
    const blocks = serverBlocksToTaskBlocks([
      {
        type: "thinking",
        thinking: "先看一眼",
        at: "2026-09-29T13:00:00.000Z",
      },
      {
        type: "tool",
        toolCallId: "t1",
        toolName: "execute",
        status: "completed",
        input: { command: "python hello.py" },
        output: { stdout: "ok" },
        outputSummary: "ok",
        runId: "r1",
        startedAt: "2026-09-29T13:00:01.000Z",
        endedAt: "2026-09-29T13:00:02.000Z",
      },
      { type: "text", text: "跑完了", at: "2026-09-29T13:00:03.000Z" },
    ]);

    expect(blocks.map((b) => b.type)).toEqual(["reasoning", "tool", "text"]);
    expect(blocks[0]).toMatchObject({
      type: "reasoning",
      text: "先看一眼",
      at: Date.parse("2026-09-29T13:00:00.000Z"),
    });
    const tool = blocks[1];
    if (tool?.type !== "tool") throw new Error("第二块应为工具");
    expect(tool.tool).toMatchObject({
      toolCallId: "t1",
      toolName: "execute",
      status: "completed",
      summary: "ok",
      runId: "r1",
      input: { command: "python hello.py" },
    });
    expect(tool.tool.startedAt).toBe(Date.parse("2026-09-29T13:00:01.000Z"));
    expect(tool.tool.endedAt).toBe(Date.parse("2026-09-29T13:00:02.000Z"));
    expect(blocks[2]).toMatchObject({ type: "text", text: "跑完了" });
  });

  it("被权限档拦下的工具是 denied（不是「已完成」）", () => {
    const blocks = serverBlocksToTaskBlocks([
      {
        type: "tool",
        toolCallId: "t2",
        toolName: "write_file",
        status: "completed",
        output: { denied: true },
      },
    ]);
    const tool = blocks[0];
    if (tool?.type !== "tool") throw new Error("应为工具块");
    expect(tool.tool.status).toBe("denied");
  });

  it("运行中的工具保持 running；图片/引用块本地没有渲染位，跳过", () => {
    const blocks = serverBlocksToTaskBlocks([
      {
        type: "tool",
        toolCallId: "t3",
        toolName: "execute",
        status: "running",
      },
      {
        type: "image",
        assetId: "a1",
        url: "https://example.com/a.png",
        mimeType: "image/png",
        source: "upload",
      },
      {
        type: "mention",
        mentionType: "skill",
        id: "s1",
        label: "run-hello-py",
        slug: "run-hello-py",
      },
    ]);
    expect(blocks).toHaveLength(1);
    const tool = blocks[0];
    if (tool?.type !== "tool") throw new Error("应为工具块");
    expect(tool.tool.status).toBe("running");
  });

  it("没有时间戳的块也不造时间（旧数据向前兼容）", () => {
    const blocks = serverBlocksToTaskBlocks([{ type: "text", text: "老数据" }]);
    expect(blocks[0]).toEqual({ type: "text", text: "老数据" });
  });
});
