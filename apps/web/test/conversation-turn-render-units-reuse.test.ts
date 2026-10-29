import { describe, expect, it } from "vitest";
import {
  buildConversationTurnRenderUnits,
  reuseDeepEqual,
  type ConversationTurnRenderUnit,
} from "@zui/v4/conversationTurnRenderUnits.js";
import type {
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

type Rows = ConversationSnapshot["rows"]["window"];

let nextRowId = 1;

function turnHeader(
  turnId: string,
): Extract<ConversationRow, { kind: "turnHeader" }> {
  return {
    rowId: nextRowId++,
    turnId,
    productTurnId: turnId,
    entityId: `turnHeader:${turnId}`,
    createdAt: 1_000,
    createdAtSeq: 0,
    kind: "turnHeader",
    state: "running",
    startedAt: 1_000,
  };
}

function assistantText(
  turnId: string,
  text: string,
): Extract<ConversationRow, { kind: "assistantText" }> {
  return {
    rowId: nextRowId++,
    turnId,
    productTurnId: turnId,
    entityId: `assistantText:${turnId}/${nextRowId}`,
    createdAt: 1_100,
    createdAtSeq: 0,
    kind: "assistantText",
    assistantResponseId: "response-1",
    state: "streaming",
    text,
  };
}

function build(rows: Rows, previous: ConversationTurnRenderUnit[] = []) {
  return buildConversationTurnRenderUnits(rows, { nowMs: 2_000 }, previous);
}

describe("buildConversationTurnRenderUnits 引用复用", () => {
  it("行引用不变的下一帧：所有 turn 沿用上一帧引用（增量帧场景）", () => {
    const rows: Rows = [turnHeader("t1"), assistantText("t1", "正文")];
    const first = build(rows);
    // 增量帧 apply 后：window 是新数组，未触及行保持原引用。
    const second = build([...rows], first);
    expect(second).toHaveLength(first.length);
    second.forEach((unit, index) => {
      expect(unit).toBe(first[index]);
    });
  });

  it("行对象全新但深值相等：仍复用（snapshot 退化帧场景）", () => {
    const rows: Rows = [turnHeader("t1"), assistantText("t1", "正文")];
    const first = build(rows);
    const cloned: Rows = [turnHeader("t1"), assistantText("t1", "正文")];
    // 克隆行 rowId 递增了，把关键身份字段对齐成「深值相等、引用全新」。
    const header = cloned[0] as Extract<ConversationRow, { kind: "turnHeader" }>;
    const text = cloned[1] as Extract<
      ConversationRow,
      { kind: "assistantText" }
    >;
    header.rowId = (rows[0] as { rowId: number }).rowId;
    header.entityId = (rows[0] as { entityId: string }).entityId;
    text.rowId = (rows[1] as { rowId: number }).rowId;
    text.entityId = (rows[1] as { entityId: string }).entityId;
    const second = build(cloned, first);
    second.forEach((unit, index) => {
      expect(unit).toBe(first[index]);
    });
  });

  it("流式行的 text 增长：只有该 turn 换引用，历史 turn 引用稳定", () => {
    const headerT1 = turnHeader("t1");
    const textT1 = assistantText("t1", "第一轮");
    const headerT2 = turnHeader("t2");
    const textT2 = assistantText("t2", "第二轮");
    const first = build([headerT1, textT1, headerT2, textT2]);
    const grownTextT2 = { ...textT2, text: "第二轮补充内容" };
    const second = build([headerT1, textT1, headerT2, grownTextT2], first);
    expect(second).toHaveLength(2);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    // 变化行的内容与最新行一致。
    expect(second[1]?.assistantTextRows[0]).toEqual(grownTextT2);
    // 收敛：行不再变化时，merge 过的 turn 引用保持稳定。
    const third = build([headerT1, textT1, headerT2, grownTextT2], second);
    expect(third[1]).toBe(second[1]);
  });

  it("新增 turn：非末位 turn 复用，isLastTurn 变化的原末位 turn 换引用", () => {
    const headerT1 = turnHeader("t1");
    const textT1 = assistantText("t1", "第一轮");
    const headerT2 = turnHeader("t2");
    const textT2 = assistantText("t2", "第二轮");
    const headerT3 = turnHeader("t3");
    const first = build([headerT1, textT1, headerT2, textT2]);
    const second = build(
      [headerT1, textT1, headerT2, textT2, headerT3],
      first,
    );
    // t1 非末位且内容未变 → 复用；t2 因 isLastTurn 从 true 变 false → 换引用；t3 新增。
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second).toHaveLength(3);
    // 再次构建（位置稳定后）全部复用。
    const third = build(
      [headerT1, textT1, headerT2, textT2, headerT3],
      second,
    );
    expect(third[0]).toBe(second[0]);
    expect(third[1]).toBe(second[1]);
    expect(third[2]).toBe(second[2]);
  });
});

describe("reuseDeepEqual", () => {
  it("深度相等的嵌套结构沿旧引用，变化分支重建且共享未变子树", () => {
    const previous = {
      scalar: 1,
      nested: { rows: [{ id: 1 }, { id: 2 }], label: "保持" },
      list: [1, 2, 3],
    };
    const next = {
      scalar: 1,
      nested: { rows: [{ id: 1 }, { id: 2 }], label: "保持" },
      list: [1, 2, 3],
    };
    const merged = reuseDeepEqual(previous, next);
    expect(merged).toBe(previous);

    const changed = {
      scalar: 1,
      nested: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], label: "保持" },
      list: [1, 2, 3],
    };
    const mergedChanged = reuseDeepEqual(previous, changed);
    expect(mergedChanged).not.toBe(previous);
    // 未变的兄弟子树保持旧引用。
    expect(mergedChanged.list).toBe(previous.list);
    expect(mergedChanged.nested.label).toBe(previous.nested.label);
  });

  it("长度不同的数组与键数不同的对象直接取新值", () => {
    expect(reuseDeepEqual([1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
    expect(reuseDeepEqual({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(reuseDeepEqual({ a: 1 }, {})).toEqual({});
  });
});
