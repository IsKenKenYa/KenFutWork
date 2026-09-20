"use client";

import { useEffect, useMemo, useState } from "react";

import { formatElapsedSeconds } from "@/lib/elapsed";
import { toolDisplayLabel, toolTargetHint } from "@/lib/workbench-tools";
import {
  buildTimelineSpans,
  type FlatTrajectoryRow,
  flattenTrajectory,
  type TrajectoryModel,
  type TrajectoryRow,
  type TrajectoryTimelineMode,
  type TrajectoryTurn,
} from "@/lib/workbench-trajectory";

import { ToolEventDetail, toolStatusMeta } from "./tool-event";

/**
 * 轨迹视图（参考 deepseek-harness 的 Trajectory 账本）：对话之外的一个只读剖面，
 * 回答「这轮 run 里先后发生了什么、每次调用花了多久、属于哪轮对话」。
 *
 * 对齐 dsh 的三件套（v1 简化版）：
 * - **账本**：行序即事件时序，按轮次分组，全局行号 #N，工具行展开即检查器
 *   （入参/输出/耗时，与对话流的工具行同一份展开体）。
 * - **时间轴**：顶部总览条，时序（等距）/时长（按真实时刻与耗时定位）两种模式，
 *   点击一根条滚动到对应账本行。拖选聚焦与缩放平移暂未做（遗留）。
 * - **工具栏**：轮次一键折叠/展开 + 子串搜索（命中行保留全局行号）。
 *
 * 缺时刻的行如实显示「—」，不用本地时钟伪造数据。
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
  reasoning: "思考",
  text: "助手",
  tool: "工具",
};

const KIND_BAR_COLORS: Record<TrajectoryRow["kind"], string> = {
  user: "bg-primary/70",
  reasoning: "bg-sky-500/50",
  text: "bg-muted-foreground/40",
  tool: "bg-amber-500/70",
};

function RowBadge({ kind }: { kind: TrajectoryRow["kind"] }) {
  const tone =
    kind === "user"
      ? "bg-primary/10 text-primary"
      : kind === "tool"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : kind === "reasoning"
          ? "bg-sky-500/10 text-sky-700 dark:text-sky-400"
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

/** 工具行：折叠 = 一行摘要（状态/名称/动了什么/耗时），展开 = 入参 + 输出（检查器）。 */
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

function TrajectoryRowView({
  entry,
  focused,
}: {
  entry: FlatTrajectoryRow;
  focused: boolean;
}) {
  const { row } = entry;
  return (
    <div
      data-traj-key={entry.key}
      data-traj-tool={row.kind === "tool" ? row.tool.toolCallId : undefined}
      className={`flex items-start gap-2 rounded-md px-1 ${
        focused ? "bg-primary/5 ring-1 ring-primary/50" : ""
      }`}
    >
      <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] text-muted-foreground/50">
        #{entry.number}
      </span>
      <RowBadge kind={row.kind} />
      {row.kind === "tool" ? (
        <ToolRowBody row={row} />
      ) : (
        <TextRowBody text={row.text} />
      )}
      <RowTime atMs={row.atMs} />
    </div>
  );
}

/** 轮次头（可点折叠）：第 N 轮 + 起止 + 耗时 + 工具数。 */
function TurnHeader({
  turn,
  collapsed,
  onToggle,
}: {
  turn: TrajectoryTurn;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const duration =
    turn.startedAtMs !== null && turn.endedAtMs !== null
      ? formatDuration(Math.max(0, turn.endedAtMs - turn.startedAtMs))
      : null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex w-full items-center gap-2 border-b border-border/60 pb-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className={`h-3 w-3 shrink-0 transition-transform ${
          collapsed ? "" : "rotate-90"
        }`}
        fill="currentColor"
      >
        <path d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z" />
      </svg>
      <span className="font-medium text-foreground">第 {turn.index} 轮</span>
      {turn.startedAtMs !== null ? (
        <span className="font-mono">{formatClock(turn.startedAtMs)} 起</span>
      ) : null}
      {duration ? <span>· {duration}</span> : null}
      {turn.toolCount > 0 ? <span>· {turn.toolCount} 次工具调用</span> : null}
      <span className="ml-auto text-[10px]">{turn.rows.length} 行</span>
    </button>
  );
}

function rowMatchesQuery(entry: FlatTrajectoryRow, query: string): boolean {
  if (!query) return true;
  const { row } = entry;
  if (row.kind === "tool") {
    const hint = toolTargetHint(row.tool) ?? "";
    return `${row.tool.toolName} ${toolDisplayLabel(row.tool.toolName)} ${hint}`
      .toLowerCase()
      .includes(query);
  }
  return row.text.toLowerCase().includes(query);
}

export function TrajectoryView({
  model,
  startedAtMs,
  endedAtMs,
  focusToolCallId,
}: {
  model: TrajectoryModel;
  /** 整条 run 的起止（毫秒）：顶部时长条与总耗时的数据源；未知端如实缺省。 */
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** 对话流工具行「查看轨迹」跳转来的聚焦目标：滚动到该调用并高亮一瞬。 */
  focusToolCallId?: string | null;
}) {
  const [timelineMode, setTimelineMode] =
    useState<TrajectoryTimelineMode>("duration");
  const [query, setQuery] = useState("");
  /** 折叠的轮次（本地态，不持久化——与 dsh 同款取舍）。 */
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const flat = useMemo(() => flattenTrajectory(model), [model]);
  const spans = useMemo(
    () => buildTimelineSpans(model, timelineMode),
    [model, timelineMode],
  );
  const flatByKey = useMemo(() => {
    const map = new Map<string, FlatTrajectoryRow>();
    for (const entry of flat) map.set(entry.key, entry);
    return map;
  }, [flat]);
  const visible = useMemo(
    () =>
      flat.filter((entry) =>
        rowMatchesQuery(entry, query.trim().toLowerCase()),
      ),
    [flat, query],
  );

  // 对话流「查看轨迹」跳转：滚动到目标调用并高亮一瞬（轮被折叠时找不到就放弃）
  useEffect(() => {
    if (!focusToolCallId) return;
    const el = document.querySelector(`[data-traj-tool="${focusToolCallId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const key = el.getAttribute("data-traj-key");
    if (!key) return;
    setFocusedKey(key);
    const timer = setTimeout(() => setFocusedKey(null), 2000);
    return () => clearTimeout(timer);
  }, [focusToolCallId]);

  const scrollToRow = (key: string) => {
    document
      .querySelector(`[data-traj-key="${key}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const allCollapsed =
    collapsedTurns.size > 0 &&
    model.turns.every((turn) => collapsedTurns.has(turn.index));

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
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground">{totalText}</div>
          <div className="ml-auto flex items-center gap-1.5">
            {/* 模式切换的两个按钮各带 aria-pressed，容器本身无语义 */}
            <div className="flex overflow-hidden rounded-md border text-[10px]">
              {(
                [
                  ["duration", "时长"],
                  ["sequence", "时序"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={timelineMode === value}
                  onClick={() => setTimelineMode(value)}
                  className={`px-2 py-0.5 transition-colors ${
                    timelineMode === value
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索轨迹（工具 / 文件 / 关键词）"
              aria-label="搜索轨迹"
              className="w-44 rounded-md border bg-transparent px-2 py-1 text-[11px] outline-none placeholder:text-muted-foreground/60 focus:border-foreground/30"
            />
            <button
              type="button"
              onClick={() =>
                setCollapsedTurns(
                  allCollapsed
                    ? new Set()
                    : new Set(model.turns.map((turn) => turn.index)),
                )
              }
              className="rounded-md border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              {allCollapsed ? "全部展开" : "全部折叠"}
            </button>
          </div>
        </div>
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
        {/* 逐行时间轴（dsh TrajectoryTimeline 简化版）：点一根条跳到账本行。
            每根条自带 aria-label 与 title，容器是纯视觉画布。 */}
        {spans.length > 0 ? (
          <div className="relative h-5 rounded-md bg-muted/40">
            {spans.map((span) => {
              const entry = flatByKey.get(span.key);
              const title = entry
                ? `#${entry.number} ${ROW_KIND_LABELS[span.kind]}${
                    entry.row.atMs !== null
                      ? ` · ${formatClock(entry.row.atMs)}`
                      : ""
                  }${
                    entry.row.kind === "tool" && entry.row.durationMs !== null
                      ? ` · ${formatDuration(entry.row.durationMs)}`
                      : ""
                  }`
                : span.key;
              return (
                <button
                  key={span.key}
                  type="button"
                  title={title}
                  aria-label={title}
                  onClick={() => scrollToRow(span.key)}
                  style={{
                    left: `${span.xPercent}%`,
                    width: `${span.widthPercent}%`,
                  }}
                  className={`absolute top-1 h-3 rounded-sm transition-opacity hover:opacity-100 ${KIND_BAR_COLORS[span.kind]} opacity-80`}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          没有匹配「{query.trim()}」的轨迹行。
        </div>
      ) : null}

      {model.turns.map((turn) => {
        const rows = visible.filter((entry) => entry.turn === turn);
        if (rows.length === 0) return null;
        const collapsed = collapsedTurns.has(turn.index);
        return (
          <div key={turn.index} className="space-y-2">
            <TurnHeader
              turn={turn}
              collapsed={collapsed}
              onToggle={() =>
                setCollapsedTurns((prev) => {
                  const next = new Set(prev);
                  if (next.has(turn.index)) next.delete(turn.index);
                  else next.add(turn.index);
                  return next;
                })
              }
            />
            {!collapsed ? (
              <div className="space-y-1.5">
                {rows.map((entry) => (
                  <TrajectoryRowView
                    key={entry.key}
                    entry={entry}
                    focused={focusedKey === entry.key}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
