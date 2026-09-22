"use client";

import { useState } from "react";

import type { TurnRailItem } from "@/lib/workbench-trajectory";

/**
 * 对话区左缘的时间线刻度（ZCode ConversationTurnNavigator 同款交互）：
 * 一轮一个短横条，hover 弹预览卡（用户消息 + 助手回复摘要），点击**纯滚动定位**
 * 到该轮（不是回滚——回滚走检查点条与右栏撤销）。
 *
 * 刻度随滚动跟随高亮由简单实现：当前轮由调用方传入（不做也成立，v1 不做）。
 * 容器 <1024px 隐藏（lg:），窄列刻度没有存在的空间。
 */
export function TurnRail({
  items,
  onJump,
}: {
  items: TurnRailItem[];
  /** 点击刻度：跳到该轮（调用方 scrollIntoView 到 data-turn-anchor）。 */
  onJump: (index: number) => void;
}) {
  /** hover 中的轮次（预览卡跟着它的刻度条渲染）。 */
  const [hovered, setHovered] = useState<number | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-y-2 left-0 z-10 hidden w-6 lg:block">
      <div className="sticky top-[38vh] flex flex-col items-center gap-1.5">
        {items.map((item) => (
          <div key={item.index} className="pointer-events-auto relative">
            <button
              type="button"
              aria-label={`跳到第 ${item.index} 轮`}
              title={`第 ${item.index} 轮`}
              onClick={() => onJump(item.index)}
              onMouseEnter={() => setHovered(item.index)}
              onMouseLeave={() =>
                setHovered((current) =>
                  current === item.index ? null : current,
                )
              }
              className="group/rail block px-2 py-1"
            >
              <span
                aria-hidden
                className="block h-0.5 w-3 rounded-full bg-muted-foreground/30 transition-all group-hover/rail:w-4 group-hover/rail:bg-foreground/70"
              />
            </button>
            {hovered === item.index ? (
              <div
                role="tooltip"
                className="absolute left-full top-1/2 z-20 ml-1 w-72 -translate-y-1/2 rounded-lg border border-border bg-popover p-2.5 text-left shadow-md"
              >
                <p className="text-[11px] text-muted-foreground">
                  第 {item.index} 轮
                  {item.startedAtMs !== null
                    ? ` · ${new Date(item.startedAtMs).toLocaleTimeString("zh-CN", { hour12: false })}`
                    : ""}
                </p>
                <p className="mt-1 line-clamp-2 text-xs font-medium text-foreground">
                  {item.userPreview || "（无用户消息）"}
                </p>
                {item.assistantPreview ? (
                  <p className="mt-0.5 line-clamp-3 text-[11px] leading-4 text-muted-foreground">
                    {item.assistantPreview}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
