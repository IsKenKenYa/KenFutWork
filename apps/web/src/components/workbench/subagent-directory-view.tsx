"use client";

import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import {
  elapsedSecondsBetween,
  formatElapsedSeconds,
  parseTimestampMs,
} from "@/lib/elapsed";
import type { SubagentBlock, SubagentEntry } from "@/lib/subagent-directory";

/**
 * 「子智能体」视图（zcode 右栏模型）：主对话只保留父派发调用的紧凑行；
 * 列表点条目 → 整个面板切成该子代理的**独立线程视图**（正文/思考/工具
 * 平铺 + 顶部返回），不是行内折叠——子代理是独立会话线程。条目转录由带
 * agentCallId 的事件路由进 SubagentEntry.blocks（lib/subagent-directory），
 * 不进主对话流。
 */
export function SubagentDirectoryView({
  entries,
  running,
}: {
  entries: SubagentEntry[];
  running: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 秒级心跳：运行中条目的时长实时走动（全部结束后不空转）
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasRunning = entries.some((entry) => !entry.endedAt);
  useEffect(() => {
    if (!hasRunning) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  if (entries.length === 0) return null;

  const selected = selectedId
    ? entries.find((entry) => entry.toolCallId === selectedId)
    : undefined;
  if (selected) {
    return (
      <SubagentThreadView
        entry={selected}
        nowMs={nowMs}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const runningEntries = entries.filter((entry) => !entry.endedAt);
  const finished = entries.length - runningEntries.length;

  return (
    <div className="space-y-2 px-1 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">子智能体</span>
        <span>
          {runningEntries.length > 0 || running
            ? `正在运行 · ${runningEntries.length}`
            : "没有正在运行的子智能体"}
        </span>
        <span aria-hidden>·</span>
        <span>已结束 · {finished}</span>
      </div>
      <ul className="space-y-1">
        {entries.map((entry) => {
          const startMs = parseTimestampMs(entry.startedAt);
          const endMs = entry.endedAt ? parseTimestampMs(entry.endedAt) : null;
          const seconds =
            startMs === null
              ? 0
              : elapsedSecondsBetween(startMs, endMs ?? undefined, nowMs);
          return (
            <li key={entry.toolCallId}>
              <button
                type="button"
                onClick={() => setSelectedId(entry.toolCallId)}
                title={entry.description ?? entry.name}
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-muted"
              >
                <ChevronRight
                  aria-hidden
                  className="h-3 w-3 shrink-0 text-muted-foreground/50"
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <span
                  className={
                    entry.endedAt
                      ? "shrink-0 text-muted-foreground/70"
                      : "shrink-0 text-emerald-600"
                  }
                >
                  {entry.endedAt ? "已结束" : "运行中"}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground/70">
                  {formatElapsedSeconds(seconds)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 单个子代理的独立线程视图：头部（返回 + 名字 + 状态 + 时长）+ 全量转录。 */
function SubagentThreadView({
  entry,
  nowMs,
  onBack,
}: {
  entry: SubagentEntry;
  nowMs: number;
  onBack: () => void;
}) {
  const startMs = parseTimestampMs(entry.startedAt);
  const endMs = entry.endedAt ? parseTimestampMs(entry.endedAt) : null;
  const seconds =
    startMs === null
      ? 0
      : elapsedSecondsBetween(startMs, endMs ?? undefined, nowMs);
  return (
    <div className="px-1 py-2">
      <div className="flex items-center gap-1.5 pb-2 text-xs">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回子智能体列表"
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          子智能体
        </button>
        <span className="ml-1 min-w-0 flex-1 truncate font-medium text-foreground">
          {entry.name}
        </span>
        <span
          className={
            entry.endedAt
              ? "shrink-0 text-muted-foreground/70"
              : "shrink-0 text-emerald-600"
          }
        >
          {entry.endedAt ? "已结束" : "运行中"}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {formatElapsedSeconds(seconds)}
        </span>
      </div>
      {entry.description ? (
        <p className="line-clamp-3 pb-2 text-[11px] leading-relaxed text-muted-foreground/80">
          {entry.description}
        </p>
      ) : null}
      <div className="border-t pt-2">
        <SubagentTranscript entry={entry} />
      </div>
    </div>
  );
}

/** 单个子代理的独立转录：正文平铺、思考弱化行、工具紧凑行（zcode 扁平风）。 */
function SubagentTranscript({ entry }: { entry: SubagentEntry }) {
  if (entry.blocks.length === 0) {
    return (
      <p className="py-1 text-[11px] text-muted-foreground/60">
        {entry.endedAt ? "该子智能体没有产出可显示的内容" : "正在执行…"}
      </p>
    );
  }
  return (
    <div className="space-y-1 text-xs">
      {entry.blocks.map((block, index) => {
        // 块无稳定 id：key 用「类型 + 序号」，追加/续写都是尾插不重排
        const key =
          block.type === "tool"
            ? `tool-${block.tool.toolCallId}`
            : `${block.type}-${index}`;
        return <SubagentBlockRow key={key} block={block} />;
      })}
    </div>
  );
}

function SubagentBlockRow({ block }: { block: SubagentBlock }) {
  if (block.type === "thinking") {
    return (
      <p className="whitespace-pre-wrap text-muted-foreground/70">
        思考 · {block.text}
      </p>
    );
  }
  if (block.type === "text") {
    return <p className="whitespace-pre-wrap">{block.text}</p>;
  }
  const duration =
    block.tool.startedAt !== undefined && block.tool.endedAt !== undefined
      ? formatElapsedSeconds(
          elapsedSecondsBetween(
            block.tool.startedAt,
            block.tool.endedAt,
            Date.now(),
          ),
        )
      : null;
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <span
        aria-hidden
        className={
          block.tool.status === "running"
            ? "text-amber-500"
            : "text-emerald-600"
        }
      >
        ●
      </span>
      <span className="min-w-0 truncate font-medium text-foreground/80">
        {block.tool.toolName}
      </span>
      {block.tool.outputSummary ? (
        <span className="min-w-0 truncate text-muted-foreground/70">
          {block.tool.outputSummary}
        </span>
      ) : null}
      {duration ? (
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/60">
          {duration}
        </span>
      ) : null}
    </div>
  );
}
