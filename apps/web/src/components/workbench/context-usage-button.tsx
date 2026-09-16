"use client";

import { useEffect, useRef, useState } from "react";

import {
  contextUsageView,
  type RunUsageSnapshot,
} from "@/lib/context-usage";

/**
 * 模型选择器旁的「上下文容量 / 缓存命中」浮层（R4-1）。
 *
 * 形态照参考图：按钮是**圆环 + 实际百分比**（不是图标、也不是问号），浮层第一行给
 * 「当前 / 窗口（百分比）」的读数，下面一条横向进度条，再下面是各分类占比，
 * 分隔线之后是平均缓存命中率。
 *
 * 口径（与业界一致，也是上下游字段能支持的最小口径）：
 * - **占用** = 本轮模型调用实际收到的 input tokens（最近一次调用的输入 = 当前真正占着窗口的量）
 *   ÷ 模型上下文窗口；
 * - **平均缓存命中率** = 命中缓存的输入 token ÷ 全部输入 token（**按 token 加权**，不是各次
 *   百分比的算术平均——短调用多的一轮里算术平均会虚高）；
 * - 窗口：供应商实例声明优先，没声明用 `@kenfutwork/shared` 的常见模型兜底表；
 *   两边都没有时**不给百分比**，环里显示绝对量（不写问号）。
 */
export function ContextUsageButton({
  usage,
  contextWindow,
  modelId,
}: {
  usage: RunUsageSnapshot | null | undefined;
  contextWindow: number | null | undefined;
  /** 当前模型 id（用于兜底表查窗口；BYOK 的 `<实例>:<模型>` 写法也认）。 */
  modelId?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const view = contextUsageView(usage, contextWindow, modelId ?? "");

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="上下文容量"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={view.usageLine ?? "上下文容量与缓存命中"}
        onClick={() => setOpen((current) => !current)}
        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ContextRing
          percent={view.percent}
          fallbackLabel={view.hasUsage ? view.inputLabel : null}
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="上下文容量与缓存命中"
          className="absolute right-0 bottom-full z-50 mb-2 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
        >
          {/* 第一行：当前 / 窗口（百分比）——参考图的读数 */}
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium">上下文容量</span>
            <span className="tabular-nums">
              {view.usageLine ?? "本轮暂无用量"}
            </span>
          </div>

          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-info"
              style={{ width: `${view.percent ?? 0}%` }}
            />
          </div>

          {view.composition.length > 0 ? (
            <ul aria-label="上下文分类占比" className="mt-3 space-y-1 text-xs">
              {view.composition.map((part) => (
                <li
                  key={part.label}
                  className="flex items-center justify-between"
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full bg-info"
                    />
                    {part.label}
                  </span>
                  <span className="tabular-nums">{part.percent}%</span>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-3 flex items-center justify-between border-t pt-2 text-xs">
            <span className="text-muted-foreground">平均缓存命中率</span>
            <span className="tabular-nums">
              {view.cacheHitLabel ?? "上游未上报"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 容量圆环：一圈轨道 + 一段进度弧，中心写**实际百分比**（参考图口径：一眼看出占了多少）。
 *
 * 窗口未知（既没声明、兜底表也认不出）时不编百分比：环里写**绝对量**（如 `51万`），
 * 不写问号——问号等于什么都没给。
 */
function ContextRing({
  percent,
  fallbackLabel,
}: {
  percent: number | null;
  fallbackLabel: string | null;
}) {
  const size = 22;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;

  return (
    <span className="relative inline-flex items-center justify-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-border"
        />
        {percent !== null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            className="stroke-info"
          />
        ) : null}
      </svg>
      <span className="absolute text-[7px] leading-none tabular-nums">
        {percent !== null ? Math.round(percent) : (fallbackLabel ?? "—")}
      </span>
    </span>
  );
}
