"use client";

import { ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import {
  elapsedSecondsBetween,
  formatElapsedSeconds,
  parseTimestampMs,
} from "@/lib/elapsed";
import type { SubagentEntry } from "@/lib/subagent-directory";

/**
 * 转录内的「子智能体」折叠目录（R1-3）：运行中 / 已结束计数 + 逐条
 * 名称、状态、耗时，点击展开详情（描述与起止时刻）。
 * 条目由工具事件流推导（lib/subagent-directory），无子代理时不渲染。
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
    <div className="w-fit rounded-xl border bg-muted/40 px-3 py-2">
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
      <ul className="mt-1.5 space-y-1">
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
                <li className="ml-4 space-y-0.5 py-0.5 text-[11px] text-muted-foreground/80">
                  {entry.description ? <p>{entry.description}</p> : null}
                  <p>
                    {startMs === null
                      ? ""
                      : `开始 ${new Date(startMs).toLocaleTimeString("zh-CN")}`}
                    {endMs !== null
                      ? ` · 结束 ${new Date(endMs).toLocaleTimeString("zh-CN")}`
                      : ""}
                  </p>
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ul>
    </div>
  );
}
