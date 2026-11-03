import type { StreamEvent } from "@kenfutwork/shared";
import type {
  RunTimelineChildSession,
  RunTimelineEntry,
  RunTimelineEventRow,
  RunTimelineResult,
  RunTimelineRunRow,
  RunTimelineUsage,
} from "./types.js";

/** 触发线来源的界面标签（与事件 schema 的枚举一一对应）。 */
const TRIGGER_SOURCE_LABELS = {
  "reserved-output": "输出预留线",
  fraction: "按比例阈值",
  fallback: "兜底阈值",
} as const;

/** 停止原因的界面标签。 */
const STOP_REASON_LABELS = {
  completed: "正常完成",
  output_limit: "输出达到上限",
  user_cancelled: "用户停止",
  task_stopped: "任务已停止",
  host_shutdown: "宿主退出",
} as const;

/** 钩子事件名 → 回合阶段。 */
const HOOK_LABELS = {
  "turn-start": "回合开始",
  "turn-end": "回合结束",
} as const;

/** 工具输入里最适合做一行提示的字段（按顺序取第一个非空字符串）。 */
const TOOL_INPUT_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "name",
] as const;

/** 子代理事件里值得并入父时间线的类型：工具与上下文治理，不含子 Run 起止与增量。 */
const CHILD_VISIBLE_EVENT_TYPES = new Set<StreamEvent["type"]>([
  "tool.started",
  "tool.completed",
  "run.retrying",
  "run.compacted",
  "run.hook",
]);

/**
 * 把子代理会话的事件并入父 Run 的时间线。
 *
 * 子代理事件另存为 `child-event:<子会话 id>/...`，不在父 Run 的 `<runId>/` 前缀下，
 * 这里按派发关系把两者排到一起：
 * - 只取工具与上下文治理事件，子 Run 的起止、用量与消息增量不重复出条目；
 * - 工具事件优先使用派发输入里的 `subagent_type` 作为名称，事件自带时保持原值；
 * - 缺 `agentCallId` 时用子会话 id 补上，避免与父 Run 的同号工具调用互相覆盖。
 */
export function mergeChildEvents(input: {
  runId: string;
  parentEvents: RunTimelineEventRow[];
  children: Array<{
    session: RunTimelineChildSession;
    events: RunTimelineEventRow[];
  }>;
}): RunTimelineEventRow[] {
  const dispatchLabels = new Map<string, string>();
  for (const row of input.parentEvents) {
    const event = row.event;
    if (event.type !== "tool.started") continue;
    const label = subagentLabel(event.input);
    if (label) dispatchLabels.set(`${input.runId}/${event.toolCallId}`, label);
  }

  const merged: RunTimelineEventRow[] = [...input.parentEvents];
  for (const child of input.children) {
    const label = dispatchLabels.get(child.session.parentToolCallId);
    for (const row of child.events) {
      if (!CHILD_VISIBLE_EVENT_TYPES.has(row.event.type)) continue;
      merged.push({
        seq: row.seq,
        createdAt: row.createdAt,
        event: labelChildEvent(row.event, label, child.session.childSessionId),
      });
    }
  }
  return merged;
}

/** 派发输入里的子代理类型；缺失或空白时不猜。 */
function subagentLabel(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const value = input?.["subagent_type"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 给子代理工具事件补名称与分组键；已有值保持原样。 */
function labelChildEvent(
  event: StreamEvent,
  agentName: string | undefined,
  childSessionId: string,
): StreamEvent {
  if (event.type !== "tool.started" && event.type !== "tool.completed")
    return event;
  return {
    ...event,
    ...(event.agentName === undefined && agentName !== undefined
      ? { agentName }
      : {}),
    ...(event.agentCallId === undefined ? { agentCallId: childSessionId } : {}),
  };
}

/** 构建时间线：把流事件投影成可回看的条目，并合并同一工具调用的开始与完成。 */
export function buildRunTimeline(input: {
  run: RunTimelineRunRow;
  events: RunTimelineEventRow[];
  usage: RunTimelineUsage | null;
}): RunTimelineResult {
  const ordered = [...input.events].sort((a, b) => a.seq - b.seq);
  const entries: RunTimelineEntry[] = [];
  const openTools = new Map<
    string,
    { entry: RunTimelineEntry; startedMs: number }
  >();
  let eventUsage: RunTimelineUsage | null = null;

  for (const row of ordered) {
    const event = row.event;
    if (event.type === "tool.started") {
      const detail = toolInputDetail(event.input);
      const entry: RunTimelineEntry = {
        kind: "tool",
        seq: row.seq,
        at: event.timestamp,
        title: event.toolName,
        status: "running",
        name: event.toolName,
        ...(event.agentName ? { agentName: event.agentName } : {}),
        ...(detail ? { detail } : {}),
      };
      entries.push(entry);
      openTools.set(toolKey(event), {
        entry,
        startedMs: Date.parse(event.timestamp),
      });
      continue;
    }

    if (event.type === "tool.completed") {
      const key = toolKey(event);
      const pending = openTools.get(key);
      const finishedMs = Date.parse(event.timestamp);
      const durationMs =
        pending &&
        Number.isFinite(pending.startedMs) &&
        Number.isFinite(finishedMs)
          ? Math.max(0, finishedMs - pending.startedMs)
          : undefined;
      const entry: RunTimelineEntry = pending?.entry ?? {
        kind: "tool",
        seq: row.seq,
        at: event.timestamp,
        title: event.toolName,
        name: event.toolName,
      };
      if (!pending) entries.push(entry);
      if (event.status) entry.status = event.status;
      if (event.outputSummary) entry.detail = event.outputSummary;
      if (durationMs !== undefined) entry.durationMs = durationMs;
      if (event.agentName) entry.agentName = event.agentName;
      openTools.delete(key);
      continue;
    }

    if (event.type === "run.started") {
      entries.push({
        kind: "run",
        seq: row.seq,
        at: event.timestamp,
        title: "开始运行",
      });
      continue;
    }

    if (event.type === "run.completed") {
      const parts: string[] = [];
      if (event.stopReason) parts.push(STOP_REASON_LABELS[event.stopReason]);
      if (event.operationResult) {
        parts.push(
          event.operationResult.status === "applied"
            ? "手动压缩已应用"
            : `手动压缩未生效（${
                event.operationResult.reason === "insufficient_history"
                  ? "历史不足"
                  : "没有减少"
              }）`,
        );
      }
      entries.push({
        kind: "run",
        seq: row.seq,
        at: event.timestamp,
        title: "运行完成",
        status: "success",
        ...(parts.length ? { detail: parts.join(" · ") } : {}),
      });
      continue;
    }

    if (event.type === "run.canceled") {
      entries.push({
        kind: "run",
        seq: row.seq,
        at: event.timestamp,
        title: "运行已停止",
        status: "cancelled",
        ...(event.stopReason
          ? { detail: STOP_REASON_LABELS[event.stopReason] }
          : {}),
      });
      continue;
    }

    if (event.type === "run.failed") {
      entries.push({
        kind: "run",
        seq: row.seq,
        at: event.timestamp,
        title: "运行失败",
        status: "error",
        name: event.error.code,
        detail: event.error.message,
      });
      continue;
    }

    if (event.type === "run.retrying") {
      entries.push({
        kind: "retry",
        seq: row.seq,
        at: event.timestamp,
        title: `第 ${event.attempt} 次尝试（共 ${event.maxAttempts} 次）`,
        detail: event.reason,
      });
      continue;
    }

    if (event.type === "run.compacted") {
      const parts = [
        event.origin === "manual" ? "手动压缩" : "自动压缩",
        `保留最近 ${event.keepMessages} 条消息`,
      ];
      if (event.triggerSource)
        parts.push(TRIGGER_SOURCE_LABELS[event.triggerSource]);
      entries.push({
        kind: "compaction",
        seq: row.seq,
        at: event.timestamp,
        title: "压缩上下文",
        detail: parts.join(" · "),
      });
      continue;
    }

    if (event.type === "run.hook") {
      entries.push({
        kind: "hook",
        seq: row.seq,
        at: event.timestamp,
        title: `钩子 · ${HOOK_LABELS[event.event]}`,
        name: event.event,
        status: event.timedOut
          ? "error"
          : event.exitCode === 0
            ? "success"
            : "error",
        durationMs: event.durationMs,
        ...(event.output.trim() ? { detail: event.output.trim() } : {}),
      });
      continue;
    }

    if (event.type === "task.notification") {
      entries.push({
        kind: event.kind === "subagent" ? "subagent" : "command",
        seq: row.seq,
        at: event.timestamp,
        title: event.label,
        name: event.label,
        status:
          event.status === "completed"
            ? "success"
            : event.status === "failed"
              ? "error"
              : "cancelled",
        detail: event.nextStep
          ? `${event.summary} · 下一步：${event.nextStep}`
          : event.summary,
      });
      continue;
    }

    if (event.type === "run.usage") {
      if (
        event.runInputTokens !== undefined &&
        event.runOutputTokens !== undefined
      ) {
        eventUsage = {
          inputTokens: event.runInputTokens,
          outputTokens: event.runOutputTokens,
          costUsd: null,
        };
      }
    }
  }

  return {
    run: {
      runId: input.run.runId,
      model: input.run.model,
      status: input.run.status,
      stopReason: input.run.stopReason,
      errorCode: input.run.errorCode,
      errorMessage: input.run.errorMessage,
      startedAt: input.run.startedAt,
      completedAt: input.run.completedAt,
      usage: input.usage ?? eventUsage,
    },
    entries,
  };
}

/** 同一工具调用的合并键：子代理内部的调用按派发 id 分组，避免与主 agent 撞号。 */
function toolKey(event: {
  toolCallId: string;
  agentCallId?: string | undefined;
}): string {
  return `${event.agentCallId ?? ""}|${event.toolCallId}`;
}

/** 从工具输入里挑一个能说明「在做什么」的字段。 */
function toolInputDetail(
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) return undefined;
  for (const key of TOOL_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length)
      return value.map((item) => String(item)).join(" ");
  }
  return undefined;
}
