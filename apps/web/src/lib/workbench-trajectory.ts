/**
 * 轨迹视图（参考 deepseek-harness 的 Trajectory 账本）的纯逻辑：把工作台任务的
 * 有序消息块投影成「按轮次分组、按时间排序」的账本行。
 *
 * 为什么单独一层：轨迹行既要容忍三种数据形态（新数据带块级时间戳 / 旧数据只有
 * 消息级时间 / 更旧的数据什么时间都没有），又不能为凑时间戳伪造数据——缺时刻
 * 的行就如实显示「—」。轮次以用户消息为界：一条用户消息开启一轮，其后所有助手
 * 消息（含其中的全部工具调用）都归属该轮，回答了「这些工具分别属于哪次对话」。
 */

import type {
  TaskMessage,
  TaskMessageBlock,
  TaskToolEntry,
} from "./workbench-tools";

/** 账本一行的类别（badge 文案由渲染层映射：用户 / 助手 / 工具）。 */
export type TrajectoryRowKind = "user" | "text" | "tool";

/** 账本一行：一次用户发言 / 一段助手正文 / 一次工具调用，按发生顺序排列。 */
export type TrajectoryRow =
  | { kind: "user"; atMs: number | null; text: string }
  | { kind: "text"; atMs: number | null; text: string }
  | {
      kind: "tool";
      atMs: number | null;
      /** startedAt→endedAt；缺任一端（还在跑 / 旧数据）为 null，如实显示。 */
      durationMs: number | null;
      tool: TaskToolEntry;
    };

/** 一轮对话：一条用户消息 + 它引发的全部助手输出。 */
export type TrajectoryTurn = {
  /** 1 起始的轮次序号。 */
  index: number;
  startedAtMs: number | null;
  /** 下一轮开始（或 null=最后一轮/仍在跑）。 */
  endedAtMs: number | null;
  rows: TrajectoryRow[];
  toolCount: number;
};

export type TrajectoryModel = {
  turns: TrajectoryTurn[];
  toolCount: number;
};

function rowsFromAssistantMessage(
  message: TaskMessage,
  rows: TrajectoryRow[],
): void {
  const blocks: TaskMessageBlock[] | undefined = message.blocks;
  if (!blocks) {
    // 旧数据：整条消息只有全文，落成一行正文
    if (message.text) {
      rows.push({
        kind: "text",
        atMs: message.startedAt ?? null,
        text: message.text,
      });
    }
    return;
  }
  for (const block of blocks) {
    if (block.type === "text") {
      if (!block.text) continue;
      rows.push({
        kind: "text",
        atMs: block.at ?? message.startedAt ?? null,
        text: block.text,
      });
      continue;
    }
    const { startedAt, endedAt } = block.tool;
    rows.push({
      kind: "tool",
      atMs: startedAt ?? null,
      durationMs:
        startedAt !== undefined && endedAt !== undefined
          ? Math.max(0, endedAt - startedAt)
          : null,
      tool: block.tool,
    });
  }
}

/**
 * 消息序列 → 按轮次分组的账本。没有用户消息的任务（理论不存在，防御性处理）
 * 全部归入第 1 轮，不丢行。
 */
export function buildTrajectory(
  messages: readonly TaskMessage[],
): TrajectoryModel {
  const turns: TrajectoryTurn[] = [];
  let current: TrajectoryTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = {
        index: turns.length + 1,
        startedAtMs: message.startedAt ?? null,
        endedAtMs: null,
        rows: [
          {
            kind: "user",
            atMs: message.startedAt ?? null,
            text: message.text,
          },
        ],
        toolCount: 0,
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = {
        index: 1,
        startedAtMs: message.startedAt ?? null,
        endedAtMs: null,
        rows: [],
        toolCount: 0,
      };
      turns.push(current);
    }
    rowsFromAssistantMessage(message, current.rows);
  }
  // 轮次收尾：下一轮的开始即上一轮的结束（最后一轮保持 null=进行中/未定）
  for (let i = 0; i < turns.length - 1; i += 1) {
    const turn = turns[i];
    const next = turns[i + 1];
    if (!turn || !next) continue;
    turn.endedAtMs = next.startedAtMs;
  }
  let toolCount = 0;
  for (const turn of turns) {
    turn.toolCount = turn.rows.filter((row) => row.kind === "tool").length;
    toolCount += turn.toolCount;
  }
  return { turns, toolCount };
}
