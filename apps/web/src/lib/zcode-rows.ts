import type { ConversationRow } from "@/components/workbench/zcode/lib/zcode-shared/zcode-protocol-v4/rows";
import type { TaskMessage, TaskMessageBlock } from "@/lib/workbench-tools";

/**
 * DeepAgents 事件归约产物（TaskMessage/TaskToolEntry）→ zcode v4 `ConversationRow[]`
 * 投影（手册 §4.3 适配层）。**这是数据适配，不是 UI**——渲染全部由
 * `<ConversationTimeline rows={…} />`（zcode 原件）承担。
 *
 * 终态形态：WS 事件归约层直接产出 rows、删掉 TaskMessage 中间形状（后端配合改，
 * 用户已确认无旧数据负担）。当前先以 TaskMessage 为源做纯函数投影，让原件先跑起来；
 * 归约层直迁属后续归约层重构。
 *
 * 映射：user → userInputRow（origin realUser）；blocks 内 reasoning → reasoningRow、
 * text → assistantTextRow、tool → toolCallRow、task_notification（后台子代理完成）→
 * subagentRow（backgrounded: true——zcode 后台子代理的正式行形态）。
 */

type SubagentEntryLite = {
  toolCallId: string;
  name: string;
  description?: string;
  endedAt?: string;
  startedAt: string;
};

function base(
  rowId: number,
  turnId: string,
  createdAt: number,
  seq: number,
): Pick<ConversationRow, "rowId" | "turnId" | "createdAt" | "createdAtSeq"> {
  return { rowId, turnId, createdAt, createdAtSeq: seq };
}

/** 单条消息 → 行数组（一条 assistant 消息展开为多行：思考/正文/工具各一行）。 */
function rowsFromMessage(
  msg: TaskMessage,
  turnId: string,
  state: { rowId: number; seq: number },
): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const createdAt = msg.startedAt ?? Date.now();

  if (msg.role === "user") {
    state.rowId += 1;
    state.seq += 1;
    rows.push({
      ...base(state.rowId, turnId, createdAt, state.seq),
      kind: "userInput",
      text: msg.text,
      origin: "realUser",
    });
    return rows;
  }

  for (const block of msg.blocks) {
    if (block.type === "reasoning") {
      state.rowId += 1;
      state.seq += 1;
      rows.push({
        ...base(state.rowId, turnId, createdAt, state.seq),
        kind: "reasoning",
        text: block.text,
        state: "complete",
        ...(msg.elapsedMs !== undefined ? { durationMs: msg.elapsedMs } : {}),
      });
    } else if (block.type === "text") {
      if (!block.text.trim()) continue;
      state.rowId += 1;
      state.seq += 1;
      rows.push({
        ...base(state.rowId, turnId, createdAt, state.seq),
        kind: "assistantText",
        text: block.text,
        state: "complete",
      });
    } else if (block.type === "tool") {
      const tool = block.tool;
      const failed = tool.summary?.startsWith("失败") === true;
      state.rowId += 1;
      state.seq += 1;
      rows.push({
        ...base(state.rowId, turnId, createdAt, state.seq),
        kind: "toolCall",
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
        status:
          tool.status === "running"
            ? "running"
            : tool.status === "denied" || failed
              ? "error"
              : "success",
        inputText: "",
        ...(tool.input ? { input: tool.input } : {}),
        ...(tool.output
          ? { output: { text: JSON.stringify(tool.output) } }
          : {}),
        ...(failed && tool.summary
          ? { error: { code: "tool_error", message: tool.summary } }
          : {}),
        ...(tool.startedAt !== undefined ? { startedAt: tool.startedAt } : {}),
        ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
      });
    } else if (block.type === "task_notification") {
      // 后台子代理完成通知 → zcode 后台子代理行（backgrounded）。
      const n = block.notification;
      const subagentType = n.label.split(" · ")[0] ?? n.label;
      state.rowId += 1;
      state.seq += 1;
      rows.push({
        ...base(state.rowId, turnId, createdAt, state.seq),
        kind: "subagent",
        subagentType,
        status:
          n.status === "completed"
            ? "success"
            : n.status === "failed"
              ? "failed"
              : "cancelled",
        summaryText: [n.summary, n.nextStep ? `（${n.nextStep}）` : ""]
          .filter(Boolean)
          .join(" "),
        backgrounded: true,
      });
    }
  }
  return rows;
}

/**
 * 任务全量消息 → zcode 行数组（保序；rowId/createdAtSeq 全局递增）。
 * 子代理行（subagentRow，前台目录条目投影）紧跟其派发 toolCall 行之后插入。
 */
export function toConversationRows(task: {
  id: string;
  messages: TaskMessage[];
  subagents?: SubagentEntryLite[];
}): ConversationRow[] {
  const state = { rowId: 0, seq: 0 };
  const rows: ConversationRow[] = [];

  for (const msg of task.messages) {
    const before = rows.length;
    const produced = rowsFromMessage(msg, task.id, state);
    rows.push(...produced);
    if (!task.subagents || task.subagents.length === 0) continue;
    // 子代理行：插到对应派发 toolCall 行之后
    let insertOffset = 0;
    for (const row of produced) {
      if (row.kind !== "toolCall") continue;
      const entry = task.subagents.find(
        (candidate) => candidate.toolCallId === row.toolCallId,
      );
      if (!entry) continue;
      insertOffset += 1;
      const startedMs = Date.parse(entry.startedAt);
      state.rowId += 1;
      state.seq += 1;
      const subagentRow: ConversationRow = {
        ...base(
          state.rowId,
          task.id,
          Number.isNaN(startedMs) ? Date.now() : startedMs,
          state.seq,
        ),
        kind: "subagent",
        parentToolCallId: row.toolCallId,
        subagentType: entry.name,
        status: entry.endedAt ? "success" : ("running" as const),
        summaryText: entry.description ?? entry.name,
        ...(Number.isNaN(startedMs) ? {} : { startedAt: startedMs }),
        ...(entry.endedAt
          ? { endedAt: Date.parse(entry.endedAt) || undefined }
          : {}),
      };
      rows.splice(before + insertOffset, 0, subagentRow);
      state.rowId += 1;
    }
  }
  return rows;
}
