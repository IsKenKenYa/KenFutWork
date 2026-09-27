"use client";

import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import {
  elapsedSecondsBetween,
  formatElapsedSeconds,
  parseTimestampMs,
} from "@/lib/elapsed";
import type { SubagentBlock, SubagentEntry } from "@/lib/subagent-directory";

/**
 * 「子智能体」视图（zcode 右栏模型）：主对话只保留父派发调用的紧凑行，
 * 子代理自己的正文/思考/工具在**这里**看——列表选中条目，下方展开它的
 * 独立转录。条目转录由带 agentCallId 的事件路由进 SubagentEntry.blocks
 * （lib/subagent-directory），不进主对话流。
 */
export function SubagentDirectoryView({
  entries,
  running,
}: {
  entries: SubagentEntry[];
  running: boolean;
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  if (entries.length === 0) return null;

  const runningEntries = entries.filter((entry) => !entry.endedAt);
  const finished = entries.length - runningEntries.length;

  const toggle = (toolCallId: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolCallId)) {
        next.delete(toolCallId);
      } else {
        next.add(toolCallId);
      }
      return next;
    });
  };

  return (
    <div className="space-y-2 px-1 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">子智能体</span>
        <span>
          {running
            ? `正在运行 · ${runningEntries.length}`
            : runningEntries.length === 0
              ? "没有正在运行的子智能体"
              : `正在运行 · ${runningEntries.length}`}
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
              : elapsedSecondsBetween(startMs, endMs ?? undefined, Date.now());
          const open = openIds.has(entry.toolCallId);
          return (
            <Fragment key={entry.toolCallId}>
              <li>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(entry.toolCallId)}
                  className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs transition-colors hover:bg-muted"
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
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
              {open ? (
                <li className="ml-3 border-l pl-2">
                  {entry.description ? (
                    <p className="py-0.5 text-[11px] text-muted-foreground/80">
                      {entry.description}
                    </p>
                  ) : null}
                  <SubagentTranscript entry={entry} />
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}

/** 单个子代理的独立转录：正文平铺、思考弱化行、工具紧凑行（zcode 扁平风）。 */
function SubagentTranscript({ entry }: { entry: SubagentEntry }) {
  if (entry.blocks.length === 0) {
    return (
      <p className="py-1 text-[11px] text-muted-foreground/60">
        {entry.endedAt ? "该子智能体没有产出可显示的内容" : "等待产出…"}
      </p>
    );
  }
  return (
    <div className="space-y-1 py-1 text-xs">
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
