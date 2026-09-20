"use client";

import { useMemo, useState } from "react";

import { formatElapsedSeconds } from "@/lib/elapsed";
import { toolDisplayLabel, toolTargetHint } from "@/lib/workbench-tools";
import type {
  TrajectoryModel,
  TrajectoryRow,
  TrajectoryTurn,
} from "@/lib/workbench-trajectory";

import { ToolEventDetail, toolStatusMeta } from "./tool-event";

/**
 * 轨迹视图（参考 deepseek-harness 的 Trajectory 账本）：对话之外的一个只读剖面，
 * 回答「这轮 run 里先后发生了什么、每次调用花了多久」。行序即事件时序，
 * 按轮次分组（轮 = 一条用户消息引发的全部输出）；缺时刻的行如实显示「—」，
 * 不用本地时钟伪造数据。
 */

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 不足 10 秒的耗时保留一位小数（工具调用多为亚秒级，「0 秒」没有信息量）。 */
function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`;
  return formatElapsedSeconds(ms / 1000);
}

const ROW_KIND_LABELS: Record<TrajectoryRow["kind"], string> = {
  user: "用户",
  text: "助手",
  tool: "工具",
};

function RowBadge({ kind }: { kind: TrajectoryRow["kind"] }) {
  const tone =
    kind === "user"
      ? "bg-primary/10 text-primary"
      : kind === "tool"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`w-10 shrink-0 rounded-sm px-1 py-0.5 text-center text-[10px] leading-4 ${tone}`}
    >
      {ROW_KIND_LABELS[kind]}
    </span>
  );
}

function RowTime({ atMs }: { atMs: number | null }) {
  return (
    <span className="w-[62px] shrink-0 text-right font-mono text-[10px] text-muted-foreground/70">
      {atMs !== null ? formatClock(atMs) : "—"}
    </span>
  );
}

/** 正文行：长文默认 6 行截断，点一下看全文（账本里最常见的行，不能被长文淹没）。 */
function TextRowBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 300 || text.split("\n").length > 6;
  const body = (
    <div
      className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/90 ${
        long && !expanded ? "line-clamp-6" : ""
      }`}
    >
      {text}
    </div>
  );
  if (!long) return body;
  return (
    <button
      type="button"
      className="flex min-w-0 flex-1 flex-col items-start text-left"
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? "收起" : "展开全文"}
    >
      {body}
      <span className="text-[10px] text-muted-foreground">
        {expanded ? "收起" : "展开全文"}
      </span>
    </button>
  );
}

/** 工具行：折叠 = 一行摘要（状态/名称/动了什么/耗时），展开 = 入参 + 输出。 */
function ToolRowBody({
  row,
}: {
  row: Extract<TrajectoryRow, { kind: "tool" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { tool } = row;
  const hasDetail =
    Boolean(tool.input) || Boolean(tool.output) || Boolean(tool.summary);
  const hint = toolTargetHint(tool);
  const meta = toolStatusMeta(tool);
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        disabled={!hasDetail}
        aria-expanded={hasDetail ? expanded : undefined}
        onClick={() => hasDetail && setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2 text-left text-xs ${
          hasDetail ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dotClass}`}
        />
        <span className="shrink-0 font-medium">
          {toolDisplayLabel(tool.toolName)}
        </span>
        {hint ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
            {hint}
          </span>
        ) : null}
        <span
          className={`ml-auto shrink-0 ${
            meta.failed
              ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground"
          }`}
        >
          {meta.text}
          {row.durationMs !== null
            ? ` · ${formatDuration(row.durationMs)}`
            : ""}
        </span>
        {hasDetail ? (
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            fill="currentColor"
          >
            <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
          </svg>
        ) : null}
      </button>
      {expanded ? <ToolEventDetail tool={tool} /> : null}
    </div>
  );
}

function TrajectoryRowView({ row }: { row: TrajectoryRow }) {
  return (
    <div className="flex items-start gap-2">
      <RowBadge kind={row.kind} />
      {row.kind === "text" ? (
        <TextRowBody text={row.text} />
      ) : row.kind === "tool" ? (
        <ToolRowBody row={row} />
      ) : (
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
          {row.text}
        </div>
      )}
      <RowTime atMs={row.atMs} />
    </div>
  );
}

/** 轮次头：第 N 轮 + 起止 + 耗时 + 工具数。 */
function TurnHeader({ turn }: { turn: TrajectoryTurn }) {
  const duration =
    turn.startedAtMs !== null && turn.endedAtMs !== null
      ? formatDuration(Math.max(0, turn.endedAtMs - turn.startedAtMs))
      : null;
  return (
    <div className="flex items-center gap-2 border-b border-border/60 pb-1 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">第 {turn.index} 轮</span>
      {turn.startedAtMs !== null ? (
        <span className="font-mono">{formatClock(turn.startedAtMs)} 起</span>
      ) : null}
      {duration ? <span>· {duration}</span> : null}
      {turn.toolCount > 0 ? <span>· {turn.toolCount} 次工具调用</span> : null}
    </div>
  );
}

export function TrajectoryView({
  model,
  startedAtMs,
  endedAtMs,
}: {
  model: TrajectoryModel;
  /** 整条 run 的起止（毫秒）：顶部时长条与总耗时的数据源；未知端如实缺省。 */
  startedAtMs: number | null;
  endedAtMs: number | null;
}) {
  const totalText = useMemo(() => {
    const parts = [`${model.turns.length} 轮`];
    if (model.toolCount > 0) parts.push(`${model.toolCount} 次工具调用`);
    if (startedAtMs !== null && endedAtMs !== null) {
      parts.push(
        `总耗时 ${formatDuration(Math.max(0, endedAtMs - startedAtMs))}`,
      );
    }
    return parts.join(" · ");
  }, [model, startedAtMs, endedAtMs]);

  if (model.turns.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        这条对话还没有可展示的轨迹。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">{totalText}</div>
        {/* 每轮一段的时长比例条（宽度按轮耗时，缺时刻的轮退化为等宽） */}
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {model.turns.map((turn) => (
            <div
              key={turn.index}
              title={`第 ${turn.index} 轮${
                turn.startedAtMs !== null && turn.endedAtMs !== null
                  ? ` · ${formatDuration(Math.max(0, turn.endedAtMs - turn.startedAtMs))}`
                  : ""
              }${turn.toolCount > 0 ? ` · ${turn.toolCount} 次工具调用` : ""}`}
              style={{
                flexGrow:
                  turn.startedAtMs !== null && turn.endedAtMs !== null
                    ? Math.max(1, turn.endedAtMs - turn.startedAtMs)
                    : 1,
              }}
              className="min-w-[6px] bg-primary/25 transition-colors hover:bg-primary/50"
            />
          ))}
        </div>
      </div>
      {model.turns.map((turn) => (
        <div key={turn.index} className="space-y-2">
          <TurnHeader turn={turn} />
          <div className="space-y-1.5">
            {turn.rows.map((row, ri) => (
              <TrajectoryRowView
                // biome-ignore lint/suspicious/noArrayIndexKey: 账本行是纯投影，行序即时序且行内无稳定 id
                key={ri}
                row={row}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
