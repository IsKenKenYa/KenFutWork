import { describe, expect, it } from "vitest";

import { recentMessagesFromSnapshot } from "../src/components/workbench/zcode/voice/recent-messages.js";

/**
 * Code 转录 → 「想」段上下文：只取真实用户输入与已完成的助手正文；
 * 工具行/思考行/流式未完成的正文不进上下文（塞进去只会污染改写）。
 */
describe("recentMessagesFromSnapshot", () => {
  const row = (extra: Record<string, unknown>) => ({
    rowId: 1,
    turnId: "t",
    createdAt: "2026-10-09T00:00:00.000Z",
    createdAtSeq: 1,
    ...extra,
  });

  const snapshot = (rows: Array<Record<string, unknown>>) =>
    ({
      rows: { window: rows, totalCount: rows.length, firstRowId: 1 },
    }) as never;

  it("取真实用户输入与已完成助手正文，按时间序", () => {
    const context = recentMessagesFromSnapshot(
      snapshot([
        row({
          rowId: 1,
          kind: "userInput",
          origin: "realUser",
          text: "改按钮",
        }),
        row({
          rowId: 2,
          kind: "assistantText",
          text: "改好了",
          state: "complete",
        }),
      ]),
    );
    expect(context).toEqual([
      { role: "user", content: "改按钮" },
      { role: "assistant", content: "改好了" },
    ]);
  });

  it("工具行 / 思考行 / 非真实用户输入不进上下文", () => {
    const context = recentMessagesFromSnapshot(
      snapshot([
        row({
          rowId: 1,
          kind: "userInput",
          origin: "backgroundResult",
          text: "后台结果",
        }),
        row({ rowId: 2, kind: "reasoning", text: "想一下", state: "complete" }),
        row({
          rowId: 3,
          kind: "assistantText",
          text: "还在写",
          state: "streaming",
        }),
        row({
          rowId: 4,
          kind: "assistantText",
          text: "写完了",
          state: "complete",
        }),
      ]),
    );
    expect(context).toEqual([{ role: "assistant", content: "写完了" }]);
  });

  it("空快照回空数组（没有上下文就不喂）", () => {
    expect(recentMessagesFromSnapshot(null)).toEqual([]);
  });
});
