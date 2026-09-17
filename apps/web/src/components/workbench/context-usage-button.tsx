"use client";

import { useEffect, useRef, useState } from "react";

import { contextUsageView, type RunUsageSnapshot } from "@/lib/context-usage";

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
  maxOutputTokens,
}: {
  usage: RunUsageSnapshot | null | undefined;
  contextWindow: number | null | undefined;
  /** 当前模型 id（用于兜底表查窗口；BYOK 的 `<实例>:<模型>` 写法也认）。 */
  modelId?: string | undefined;
  /** 模型声明的单次最大输出（上下文条「预留输出」段的来源）；缺省即不画那一段。 */
  maxOutputTokens?: number | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const view = contextUsageView(
    usage,
    contextWindow,
    modelId ?? "",
    maxOutputTokens,
  );

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
    /* `inline-flex` 不能少：普通 div 会带上父级行高，环就比相邻图标**高 2px**（实测 cy 483 vs 485） */
    <div ref={containerRef} className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="上下文容量"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={view.usageLine ?? "上下文容量与缓存命中"}
        onClick={() => setOpen((current) => !current)}
        /* 与相邻图标按钮同心中线（h-8 w-8 + 居中，环本身 30）：圈才不会跟图标错开半个像素；
           hover 只给底色，**文字颜色保持前景色**（否则悬停时环的数字会被 muted 冲淡） */
        className="inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-muted"
      >
        <ContextRing
          percent={view.percent}
          overThreshold={view.overThreshold}
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

          {/* 三段条（Roo Code 口径）：已用 + 预留输出 + 剩余；接缝即「输出预留线」。
              预留输出段只在模型**声明了最大输出**时画——不编这个数 */}
          <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-l-full ${
                view.overThreshold ? "bg-amber-500" : "bg-info"
              }`}
              style={{ width: `${view.percent ?? 0}%` }}
            />
            {view.reserveTokens !== null && view.thresholdPercent !== null ? (
              <div
                className="absolute top-0 h-full bg-amber-400/50"
                style={{
                  left: `${view.thresholdPercent}%`,
                  width: `${Math.max(
                    0,
                    (view.percent ?? 0) > view.thresholdPercent
                      ? 100 - (view.percent ?? 0)
                      : Math.min(100, 100 - view.thresholdPercent),
                  )}%`,
                }}
                title="预留输出（为模型回复留出的窗口空间）"
              />
            ) : null}
            {view.thresholdPercent !== null ? (
              <div
                aria-hidden
                className="absolute top-0 h-full w-px bg-amber-600"
                style={{ left: `${view.thresholdPercent}%` }}
              />
            ) : null}
          </div>

          {view.reserveTokens !== null ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-info"
                />
                已用 {view.inputLabel}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-amber-400/70"
                />
                预留输出 {view.reserveLabel}
              </span>
              <span>剩余 {view.remainingLabel}</span>
            </div>
          ) : null}

          {view.overThreshold ? (
            <p className="mt-2 rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400">
              已越过输出预留线（
              {view.thresholdPercent !== null
                ? `窗口的 ${view.thresholdPercent}%`
                : ""}
              ）：为回复留的空间已被吃掉，再追一轮更容易被上游截断或拒绝。
              <strong className="font-medium">本产品不做自动压缩</strong>
              ——需要继续长任务请新建一个对话（或换成窗口更大的模型）。
            </p>
          ) : null}

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

          <div className="mt-3 border-t pt-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">
                平均缓存命中率
                {view.cacheHitScope === "call" ? "（本次调用）" : ""}
              </span>
              <span className="tabular-nums">
                {view.cacheHitLabel ?? "上游未上报"}
              </span>
            </div>
            {/* 命中率也画成进度条（用户口径：思考强度与缓存都要有进度条） */}
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{ width: `${view.cacheHitPercent ?? 0}%` }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 容量圆环（用户口径：**按参考图 1:1 复刻**——粗环、浅灰、顶部一个小缺口，**环里不写数字**）。
 *
 * 读法：环画的是**剩余空间**（还剩多少），缺口是已用掉的那一小段——
 * 参考图里那个「基本闭合、顶部留一点口」的样子，对应的正是「上下文还很空」。
 * 用量涨上去，缺口就跟着变大（环被吃掉）。精确读数不放环里（环太小，两位数字挤不下），
 * 在 `title` 与浮层里给（`4.5万/100万（4.5%）`）。
 *
 * 越线（吃掉为输出预留的空间）时整圈转琥珀色：那是「该收尾了」的信号，不是错误。
 * 没有用量数据时画一圈闭合的灰环（还不知道占了多少，不做假缺口）。
 */
function ContextRing({
  percent,
  overThreshold = false,
}: {
  percent: number | null;
  overThreshold?: boolean;
}) {
  // 尺寸与粗细照参考图的比例（环的粗细约等于半径的 1/4，比常见的 2.5px 明显厚）
  const size = 22;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // 画「剩余」：缺口大小 = 已用比例；留一个最小缺口，避免 0% 时缺口消失、看不出是环
  const used = percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;
  const gap = percent === null ? 0 : Math.max(0.06, used);
  const remaining = Math.max(0, 1 - gap);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="-rotate-90"
    >
      {/* 缺口当作轨道（浅灰）：比整圈都画深色更像参考图里那个「C」 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeDasharray={`${circumference * remaining} ${circumference}`}
        /* 让缺口**骑在正上方**（参考图那个口就在 12 点附近）：弧向后挪半个缺口 */
        strokeDashoffset={-((circumference * gap) / 2)}
        className={
          overThreshold ? "stroke-amber-500" : "stroke-muted-foreground"
        }
      />
    </svg>
  );
}
