/**
 * 轨迹视图（参考 deepseek-harness 的 Trajectory 账本）的纯逻辑：把工作台任务的
 * 有序消息块投影成「按轮次分组、按时间排序」的账本行。
 *
 * 为什么单独一层：轨迹行既要容忍三种数据形态（新数据带块级时间戳 / 旧数据只有
 * 消息级时间 / 更旧的数据什么时间都没有），又不能为凑时间戳伪造数据——缺时刻
 * 的行就如实显示「—」。轮次以用户消息为界：一条用户消息开启一轮，其后所有助手
 * 消息（含其中的全部工具调用）都归属该轮，回答了「这些工具分别属于哪次对话」。
 */

import type { TaskMessage, TaskToolEntry } from "./workbench-tools";

/** 账本一行的类别（badge 文案由渲染层映射：用户 / 思考 / 助手 / 工具）。 */
export type TrajectoryRowKind = "user" | "reasoning" | "text" | "tool";

/** 账本一行：一次用户发言 / 一段思考 / 一段助手正文 / 一次工具调用，按发生顺序排列。 */
export type TrajectoryRow =
  | {
      kind: "user";
      atMs: number | null;
      text: string;
      runId: string | null;
    }
  | {
      kind: "reasoning";
      atMs: number | null;
      text: string;
      runId: string | null;
    }
  | {
      kind: "text";
      atMs: number | null;
      text: string;
      runId: string | null;
    }
  | {
      kind: "tool";
      atMs: number | null;
      /** startedAt→endedAt；缺任一端（还在跑 / 旧数据）为 null，如实显示。 */
      durationMs: number | null;
      tool: TaskToolEntry;
      runId: string | null;
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
  const runId = message.runId ?? null;
  for (const block of message.blocks ?? []) {
    if (block.type === "text") {
      if (!block.text) continue;
      rows.push({
        kind: "text",
        atMs: block.at ?? message.startedAt ?? null,
        text: block.text,
        runId,
      });
      continue;
    }
    if (block.type === "reasoning") {
      if (!block.text) continue;
      rows.push({
        kind: "reasoning",
        atMs: block.at ?? message.startedAt ?? null,
        text: block.text,
        runId,
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
      runId: block.tool.runId ?? runId,
    });
  }
}

/**
 * 消息序列 → 按轮次分组的账本。没有用户消息的任务（理论不存在，防御性处理）
 * 全部归入第 1 轮，不丢行。
 */
export function buildTrajectory(
  rawMessages: readonly TaskMessage[],
): TrajectoryModel {
  // 无 blocks 的纯文本助手消息就地归一化成单文本块——账本只有一条投影路径
  const messages = rawMessages.map((message) =>
    message.role === "assistant" && !message.blocks
      ? {
          ...message,
          blocks: message.text
            ? [{ type: "text" as const, text: message.text }]
            : [],
        }
      : message,
  );
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
            runId: message.runId ?? null,
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

// ── 平铺枚举与时间轴（deepseek-harness TrajectoryTimeline 的简化版） ──

/** 跨轮平铺的一行：`key` 是 DOM 锚（时间轴点击滚动用），`number` 是全局行号 #N。 */
export type FlatTrajectoryRow = {
  key: string;
  turn: TrajectoryTurn;
  row: TrajectoryRow;
  number: number;
};

export function flattenTrajectory(model: TrajectoryModel): FlatTrajectoryRow[] {
  const flat: FlatTrajectoryRow[] = [];
  let number = 0;
  for (const turn of model.turns) {
    turn.rows.forEach((row, ri) => {
      number += 1;
      flat.push({ key: `t${turn.index}-r${ri}`, turn, row, number });
    });
  }
  return flat;
}

export type TrajectoryTimelineMode = "sequence" | "duration";

/** 时间轴一根条：几何信息（0-100 百分比）；颜色/提示由渲染层按 kind 与原行组装。 */
export type TrajectoryTimelineSpan = {
  key: string;
  kind: TrajectoryRowKind;
  xPercent: number;
  widthPercent: number;
};

/**
 * 时间轴布局：条几何 + 「时长」模式的线性时间基准（拖选聚焦据此把选区换算回
 * 时间窗）。sequence 模式没有时间基准（minStart/spanMs 为 null，不支持拖选）。
 */
export type TrajectoryTimelineLayout = {
  spans: TrajectoryTimelineSpan[];
  minStartMs: number | null;
  spanMs: number | null;
};

/** 时刻缺失的行在「时长」模式下无法定位，如实跳过（不伪造位置）。 */
export function buildTimelineLayout(
  model: TrajectoryModel,
  mode: TrajectoryTimelineMode,
): TrajectoryTimelineLayout {
  const flat = flattenTrajectory(model);
  if (flat.length === 0) return { spans: [], minStartMs: null, spanMs: null };

  if (mode === "sequence") {
    // 时序模式：行与行等距铺开（不看真实时刻——长思考不会把后面挤成一条缝）
    return {
      minStartMs: null,
      spanMs: null,
      spans: flat.map((entry, i) => ({
        key: entry.key,
        kind: entry.row.kind,
        xPercent: flat.length > 1 ? (i / (flat.length - 1)) * 96 : 0,
        widthPercent: 2,
      })),
    };
  }

  const starts = flat
    .map((entry) => entry.row.atMs)
    .filter((v): v is number => v !== null);
  if (starts.length === 0) return { spans: [], minStartMs: null, spanMs: null };
  const minStart = Math.min(...starts);
  const maxEnd = Math.max(
    ...flat.map((entry) => {
      if (entry.row.atMs === null) return minStart;
      return (
        entry.row.atMs +
        (entry.row.kind === "tool" ? (entry.row.durationMs ?? 0) : 0)
      );
    }),
  );
  const span = Math.max(1, maxEnd - minStart);
  const spans: TrajectoryTimelineSpan[] = [];
  for (const entry of flat) {
    if (entry.row.atMs === null) continue;
    const width =
      entry.row.kind === "tool" && entry.row.durationMs !== null
        ? Math.max(1.2, (entry.row.durationMs / span) * 100)
        : 1.2;
    const x = Math.min(((entry.row.atMs - minStart) / span) * 100, 100 - width);
    spans.push({
      key: entry.key,
      kind: entry.row.kind,
      xPercent: x,
      widthPercent: width,
    });
  }
  return { spans, minStartMs: minStart, spanMs: span };
}

/** 兼容入口：只要条几何时用这个。 */
export function buildTimelineSpans(
  model: TrajectoryModel,
  mode: TrajectoryTimelineMode,
): TrajectoryTimelineSpan[] {
  return buildTimelineLayout(model, mode).spans;
}

/**
 * 拖选聚焦：**可见条与选区相交**的行（WYSIWYG——条被 clamp 在 98.8% 显示时，
 * 用户框住这个条就该选中它，按原始时刻过滤会出现「框住却选不中」的错位）。
 * atMs 缺失的行没有条，聚焦期间如实隐藏（清除聚焦即回来）。
 */
export function rowsInSelection(
  flat: readonly FlatTrajectoryRow[],
  spans: readonly TrajectoryTimelineSpan[],
  selLoPercent: number,
  selHiPercent: number,
): FlatTrajectoryRow[] {
  const keys = new Set(
    spans
      .filter(
        (span) =>
          span.xPercent <= selHiPercent &&
          span.xPercent + span.widthPercent >= selLoPercent,
      )
      .map((span) => span.key),
  );
  return flat.filter((entry) => keys.has(entry.key));
}
