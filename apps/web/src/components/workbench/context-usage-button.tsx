"use client";

import { useEffect, useRef, useState } from "react";

import { contextUsageView, type RunUsageSnapshot } from "@/lib/context-usage";

/**
 * 模型选择器旁的「上下文容量 / 缓存命中」浮层（R4-1）。
 *
 * 按钮本身是**圆环 + 实际百分比**（参考图口径：不是图标，一眼能看出占了窗口多少），
 * 数据来自服务端 `run.usage` 与模型目录里的上下文窗口。**没有数据时不显示 0**：
 * 窗口未知就不给百分比，上游没报缓存就写「上游未上报」。
 */
export function ContextUsageButton({
  usage,
  contextWindow,
}: {
  usage: RunUsageSnapshot | null | undefined;
  contextWindow: number | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const view = contextUsageView(usage, contextWindow);

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
        title="上下文容量与缓存命中"
        onClick={() => setOpen((current) => !current)}
        className="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ContextRing percent={view.percent} />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="上下文容量与缓存命中"
          className="absolute right-0 bottom-full z-50 mb-2 w-72 rounded-xl border bg-popover p-3 text-popover-foreground shadow-md"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">上下文容量</span>
            <span className="tabular-nums text-muted-foreground">
              {view.hasUsage
                ? `${view.inputLabel}${view.windowLabel ? `/${view.windowLabel}` : ""}${
                    view.percentLabel ? `（${view.percentLabel}）` : ""
                  }`
                : "本轮暂无用量"}
            </span>
          </div>

          {view.percent !== null ? (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70"
                style={{ width: `${view.percent}%` }}
              />
            </div>
          ) : null}

          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">输入 token</dt>
              <dd className="tabular-nums">{view.inputLabel ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">输出 token</dt>
              <dd className="tabular-nums">{view.outputLabel ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">
                平均缓存命中率
                {view.cacheHitScope === "call" ? (
                  <span className="ml-1 text-[10px] text-muted-foreground/70">
                    （本次调用）
                  </span>
                ) : null}
              </dt>
              <dd className="tabular-nums">
                {view.cacheHitLabel ?? "上游未上报"}
              </dd>
            </div>
          </dl>
          {/* 分类占比（R4-1）：参考图那一栏。**字符数口径**——上游不提供分类 token。 */}
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

          {view.cacheHitScope === "run" ? (
            <p className="mt-2 text-[10px] text-muted-foreground/80">
              按 token 加权：累计命中缓存输入 ÷
              累计输入，不是各次百分比的算术平均。
              {view.composition.length > 0
                ? " 分类占比按字符数估算（上游不提供分类 token）。"
                : ""}
            </p>
          ) : null}

          {view.windowKnown ? null : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              该模型没有声明上下文窗口，无法计算容量占比。
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 容量圆环：一圈轨道 + 一段进度弧，中心写百分比。
 *
 * 为什么不用图标：参考图要的是「一眼看出占了多少」（圆圈 + 实际百分比）。
 * 窗口未知时百分比为 null：画空轨道、中心写「?」——不编分母、也不假装是 0%。
 */
function ContextRing({ percent }: { percent: number | null }) {
  const size = 20;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio =
    percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;

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
            className="stroke-foreground/70"
          />
        ) : null}
      </svg>
      <span className="absolute text-[8px] tabular-nums">
        {percent === null ? "?" : Math.round(percent)}
      </span>
    </span>
  );
}
