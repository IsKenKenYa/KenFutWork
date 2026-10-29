import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyConversationDeltas,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  conversationSnapshotSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { createCodeUiConversation } from "./conversation.js";
import { diffConversationSnapshots } from "./snapshot-diff.js";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";

const SESSION_ID = randomUUID();

/**
 * 真实 host：startTurn 注册运行（recordEvent 只消费当前 runId 的事件，
 * 见 conversation.ts 的 `event.runId !== runId` 早退），随后事件驱动快照演进。
 */
function createStartedHost(runId = randomUUID()) {
  const host = createCodeUiConversation({
    sessionId: SESSION_ID,
    workspacePath: "/owned/project",
    config: {
      provider: "fixture-provider",
      model: "fixture-model",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
  });
  host.startTurn({
    runId,
    commandId: randomUUID(),
    text: "测试输入",
  });
  return { host, runId };
}

/** 真实 host 的权威快照：seq/revision 由调用方推进，模拟 recordRunEvent 的事务推进。 */
function hostSnapshot(
  host: ReturnType<typeof createCodeUiConversation>,
  seq: number,
): ConversationSnapshot {
  return conversationSnapshotSchema.parse({
    ...host.getSnapshot(),
    logEpoch: "epoch-1",
    seq,
    revision: seq,
  });
}

function applyFrom(
  previous: ConversationSnapshot,
  result: ReturnType<typeof diffConversationSnapshots>,
  toSeq: number,
): ConversationSnapshot {
  expect(result.fallbackToSnapshot).toBe(false);
  expect(result.fallbackReason).toBeNull();
  const applied = applyConversationDeltas(previous, result.deltas);
  return { ...applied, seq: toSeq };
}

describe("diffConversationSnapshots（真实 host 快照）", () => {
  it("流式 message.delta 逐帧 diff 应用后与权威快照逐字段一致", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    let previous = hostSnapshot(host, 1);
    for (const [index, chunk] of ["你好", "，世界", "！完成。"].entries()) {
      host.recordEvent({
        type: "message.delta",
        runId,
        messageId: "m-1",
        delta: chunk,
        timestamp: at,
      });
      const current = hostSnapshot(host, index + 2);
      const result = diffConversationSnapshots(previous, current);
      expect(result.fallbackToSnapshot).toBe(false);
      expect(result.fallbackReason).toBeNull();
      // 首个 chunk 以 row.appended 建行，其后同 rowId 追加必须以 row.delta 表达
      // （本优化存在的意义）。
      if (index === 0) {
        expect(result.deltas.some((delta) => delta.op === "row.appended")).toBe(
          true,
        );
      } else {
        expect(
          result.deltas.some((delta) => delta.op === "row.delta"),
          `第${index}帧应含 row.delta，实际 ${JSON.stringify(result.deltas)}`,
        ).toBe(true);
      }
      expect(applyFrom(previous, result, current.seq)).toEqual(current);
      previous = current;
    }
  });

  it("thinking.delta（reasoning 行）同样走 row.delta", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    const before = hostSnapshot(host, 1);
    host.recordEvent({
      type: "thinking.delta",
      runId,
      messageId: "m-0",
      delta: "思考",
      timestamp: at,
    });
    const first = hostSnapshot(host, 2);
    const fromEmpty = diffConversationSnapshots(before, first);
    expect(
      fromEmpty.deltas.filter((delta) => delta.op === "row.appended"),
    ).toHaveLength(1);
    host.recordEvent({
      type: "thinking.delta",
      runId,
      messageId: "m-0",
      delta: "更多",
      timestamp: at,
    });
    const second = hostSnapshot(host, 3);
    const result = diffConversationSnapshots(first, second);
    expect(result.deltas).toContainEqual({
      op: "row.delta",
      path: "text",
      append: "更多",
      rowId: (second.rows.window.at(-1) as { rowId: number }).rowId,
    } satisfies ConversationDelta);
    expect(applyFrom(first, result, second.seq)).toEqual(second);
  });

  it("工具行追加与完成：row.appended 后接 row.upserted，应用结果一致", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    host.recordEvent({
      type: "tool.started",
      runId,
      toolCallId: "call-1",
      toolName: "Read",
      timestamp: at,
    });
    const before = hostSnapshot(host, 1);
    const started = hostSnapshot(host, 2);
    const startedResult = diffConversationSnapshots(before, started);
    expect(applyFrom(before, startedResult, started.seq)).toEqual(started);
    host.recordEvent({
      type: "tool.completed",
      runId,
      toolCallId: "call-1",
      toolName: "Read",
      status: "success",
      output: { text: "文件内容", truncated: false },
      timestamp: at,
    } as Parameters<typeof host.recordEvent>[0]);
    const completed = hostSnapshot(host, 3);
    const completedResult = diffConversationSnapshots(started, completed);
    expect(
      completedResult.deltas.some((delta) => delta.op === "row.upserted"),
      "工具完成必须整行替换",
    ).toBe(true);
    expect(applyFrom(started, completedResult, completed.seq)).toEqual(completed);
  });

  it("run.completed 事件（control 键变化 + 行状态迁移）应用结果一致", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-1",
      delta: "答案",
      timestamp: at,
    });
    const streaming = hostSnapshot(host, 2);
    host.recordEvent({ type: "run.completed", runId, timestamp: at });
    const completed = hostSnapshot(host, 3);
    const result = diffConversationSnapshots(streaming, completed);
    expect(applyFrom(streaming, result, completed.seq)).toEqual(completed);
  });

  it("零差异退化为 snapshot，防止客户端 seq 跳号判断档", () => {
    const { host } = createStartedHost();
    const same = hostSnapshot(host, 7);
    const result = diffConversationSnapshots(same, { ...same, seq: 8, revision: 7 });
    expect(result.fallbackToSnapshot).toBe(true);
    expect(result.fallbackReason).toBe("zero-diff");
    expect(result.deltas).toEqual([]);
  });

  it("epoch 换代退化为 snapshot", () => {
    const { host } = createStartedHost();
    const snapshot = hostSnapshot(host, 1);
    const result = diffConversationSnapshots(snapshot, {
      ...snapshot,
      logEpoch: "epoch-2",
    });
    expect(result.fallbackToSnapshot).toBe(true);
    expect(result.fallbackReason).toBe("epoch-changed");
  });

  it("行序错位退化为 snapshot", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-1",
      delta: "甲",
      timestamp: at,
    });
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-2",
      delta: "乙",
      timestamp: at,
    });
    const snapshot = hostSnapshot(host, 3);
    // 全部 4 行乱序（turnHeader/userInput/两条 text）。
    const shuffled: ConversationRow[] = [
      snapshot.rows.window[1]!,
      snapshot.rows.window[0]!,
      snapshot.rows.window[3]!,
      snapshot.rows.window[2]!,
    ];
    const result = diffConversationSnapshots(snapshot, {
      ...snapshot,
      rows: { ...snapshot.rows, window: shuffled },
    });
    expect(result.fallbackToSnapshot).toBe(true);
    expect(result.fallbackReason).toBe("row-order-mismatch");
  });

  it("性能护栏：两千行会话的单次 diff 为毫秒级（全量扫描的成本上界）", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    for (let index = 0; index < 2_000; index += 1) {
      host.recordEvent({
        type: "message.delta",
        runId,
        messageId: `m-${index}`,
        delta: `第${index}行内容，用于撑起长会话体积。`,
        timestamp: at,
      });
    }
    const before = hostSnapshot(host, 2_001);
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-live",
      delta: "尾行追加",
      timestamp: at,
    });
    const after = hostSnapshot(host, 2_002);
    const startedAt = performance.now();
    for (let round = 0; round < 10; round += 1) {
      diffConversationSnapshots(before, after);
    }
    const perCallMs = (performance.now() - startedAt) / 10;
    // 完整深比较的真实成本钉在护栏里：超界说明比较实现退化（如意外 JSON 化）。
    expect(perCallMs).toBeLessThan(50);
  });

  it("黄金测试：交替流式长序列逐帧 diff 应用与权威快照一致", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    let previous = hostSnapshot(host, 1);
    let seq = 1;
    for (let round = 0; round < 20; round += 1) {
      host.recordEvent({
        type: "message.delta",
        runId,
        messageId: "m-main",
        delta: `第${round}段正文。`,
        timestamp: at,
      });
      seq += 1;
      const withText = hostSnapshot(host, seq);
      const textResult = diffConversationSnapshots(previous, withText);
      expect(applyFrom(previous, textResult, withText.seq)).toEqual(withText);
      previous = withText;
      host.recordEvent({
        type: "tool.started",
        runId,
        toolCallId: `call-${round}`,
        toolName: "Read",
        timestamp: at,
      });
      seq += 1;
      const withTool = hostSnapshot(host, seq);
      const toolResult = diffConversationSnapshots(previous, withTool);
      expect(applyFrom(previous, toolResult, withTool.seq)).toEqual(withTool);
      previous = withTool;
    }
    // 结束前会话里确实积累了多行（diff 在真实形态下持续工作）。
    expect(previous.rows.window.length).toBeGreaterThan(20);
  });

  it("协议 schema 接受 diff 产出的 deltas 帧（wire 层形状校验）", () => {
    const { host, runId } = createStartedHost();
    const at = new Date().toISOString();
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-1",
      delta: "第一帧",
      timestamp: at,
    });
    const first = hostSnapshot(host, 2);
    host.recordEvent({
      type: "message.delta",
      runId,
      messageId: "m-1",
      delta: "第二帧",
      timestamp: at,
    });
    const second = hostSnapshot(host, 3);
    const result = diffConversationSnapshots(first, second);
    const frame = protocol.conversationTopicFrameSchema.parse({
      topic: protocol.conversationTopic(SESSION_ID),
      subscriptionId: randomUUID(),
      fromSeq: first.seq,
      toSeq: second.seq,
      sentAt: Date.now(),
      payload: { kind: "deltas", deltas: result.deltas },
    });
    expect(frame.payload.kind).toBe("deltas");
  });

  it("structuredValueEqual：嵌套数组与对象的深相等判定", async () => {
    const { structuredValueEqual } = await import("./snapshot-diff.js");
    expect(structuredValueEqual({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toBe(
      true,
    );
    expect(structuredValueEqual({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(structuredValueEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(structuredValueEqual("同", "同")).toBe(true);
    expect(structuredValueEqual("同", 1)).toBe(false);
  });
});
