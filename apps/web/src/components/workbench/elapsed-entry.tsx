"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

import {
  elapsedSecondsBetween,
  formatElapsedSeconds,
  parseTimestampMs,
} from "@/lib/elapsed";

/**
 * 转录顶部的「已工作 N 分 N 秒 ›」可折叠条目（R1-1）。
 *
 * 运行中每秒本地重算（interval 只挂在组件内部，不驱动整个工作台重渲染）；
 * 结束后定格为起止差值，点开可看起止时刻。没有 startedAt 时不渲染。
 */
export function ElapsedEntry({
  startedAt,
  endedAt,
  running,
}: {
  startedAt: string;
  endedAt?: string | undefined;
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const startMs = parseTimestampMs(startedAt);
  if (startMs === null) return null;
  const endMs = endedAt ? parseTimestampMs(endedAt) : undefined;
  const seconds = elapsedSecondsBetween(
    startMs,
    endMs ?? undefined,
    Date.now(),
  );

  const formatClock = (ms: number) =>
    new Date(ms).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className="w-fit">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        已工作 {formatElapsedSeconds(seconds)}
        {running ? "…" : ""}
      </button>
      {open ? (
        <div className="mt-1 ml-5 text-xs text-muted-foreground/80">
          开始 {formatClock(startMs)}
          {endMs !== null && endMs !== undefined
            ? ` · 结束 ${formatClock(endMs)}`
            : " · 进行中"}
        </div>
      ) : null}
    </div>
  );
}
