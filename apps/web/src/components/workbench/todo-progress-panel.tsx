"use client";

import { CheckCircle2, ChevronRight, CircleDot, Circle } from "lucide-react";
import { useState } from "react";

import { sortTodosForDisplay, todoProgress, type TodoItem } from "@/lib/todo-progress";

/**
 * 转录顶部的「目标 + 进度」面板（参考图 R1-2，源自 `write_todos` 工具事件）。
 *
 * 目标 = 本对话要达成的事（取会话标题，即第一条用户消息）；进度来自 agent 自己维护的
 * 待办表。没有待办表时**不渲染**——面板只在模型确实用了 `write_todos` 时才出现，
 * 免得简单对话里多出一块空壳（模型自己的指引也是「少于 3 步别用」）。
 */
export function TodoProgressPanel({
  goal,
  items,
  running,
}: {
  goal: string;
  items: TodoItem[];
  running: boolean;
}) {
  const [completedOpen, setCompletedOpen] = useState(false);

  const { completed, total, inProgress } = todoProgress(items);
  if (total === 0) return null;

  const ordered = sortTodosForDisplay(items);
  const completedItems = ordered.filter((item) => item.status === "completed");
  const others = ordered.filter((item) => item.status !== "completed");
  const done = completed === total;

  return (
    <section className="w-fit max-w-full rounded-xl border bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-foreground">目标</span>
        <span className="min-w-0 max-w-[32rem] truncate text-muted-foreground">
          {goal}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {done ? "已完成" : running ? "进行中" : "已停止"}
        </span>
        {done ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
        ) : null}
      </div>

      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">进度</span>
        <span className="tabular-nums">
          {completed}/{total}
        </span>
        {inProgress > 0 ? <span>· 进行中 {inProgress}</span> : null}
        <span>· 已完成 {completed}</span>
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {others.map((item, index) => (
          <li
            key={`${item.status}-${index}-${item.content}`}
            className="flex items-start gap-1.5 px-1 py-0.5 text-xs"
          >
            {item.status === "in_progress" ? (
              <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-foreground" />
            ) : (
              <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
            )}
            <span className="min-w-0 flex-1">{item.content}</span>
            <span className="shrink-0 text-muted-foreground/70">
              {item.status === "in_progress" ? "进行中" : "待办"}
            </span>
          </li>
        ))}
      </ul>

      {completedItems.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={completedOpen}
            onClick={() => setCompletedOpen((prev) => !prev)}
            className="mt-1 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            <ChevronRight
              className={`h-3 w-3 shrink-0 transition-transform ${completedOpen ? "rotate-90" : ""}`}
            />
            已完成 {completedItems.length} 项
          </button>
          {completedOpen ? (
            <ul className="space-y-0.5">
              {completedItems.map((item, index) => (
                <li
                  key={`completed-${index}-${item.content}`}
                  className="flex items-start gap-1.5 px-1 py-0.5 text-xs text-muted-foreground line-through"
                >
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1">{item.content}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
