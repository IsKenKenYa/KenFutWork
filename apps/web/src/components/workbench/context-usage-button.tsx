"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { contextUsageView, type RunUsageSnapshot } from "@/lib/context-usage";

/**
 * 模型选择器旁的「上下文容量 / 缓存命中」浮层（R4-1）。
 *
 * **悬停即展开**（用户口径：「鼠标放上去悬浮显示，而不是点击才出来」），移开收起；
 * 面板里没有可聚焦控件，所以 Tab 聚焦到环也展开、移开即收（键盘可达）。
 *
 * 形态照参考图：按钮是一个小圆环（**不写数字**，弧长 = 已用百分比），浮层第一行给
 * 「当前 / 窗口（两位小数百分比）」的读数，下面一条横向进度条，再下面是各分类占比，
 * 分隔线之后是平均缓存命中率。
 *
 * 口径（与业界一致，也是上下游字段能支持的最小口径）：
 * - **占用** = 本轮模型调用实际收到的 input tokens（最近一次调用的输入 = 当前真正占着窗口的量）
 *   ÷ 模型上下文窗口；
 * - **平均缓存命中率** = 命中缓存的输入 token ÷ 全部输入 token（**按 token 加权**，不是各次
 *   百分比的算术平均——短调用多的一轮里算术平均会虚高）；
 * - 窗口：供应商实例声明优先，没声明用 `@kenfutwork/shared` 的常见模型兜底表；
 *   两边都没有时**不给百分比**（环保持空环，读数给绝对量，不写问号）。
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
  /**
   * 关面板的防抖定时器：面板与环之间有 8px 空隙（`mb-2`），鼠标从环挪到面板时会**穿过
   * 空隙**、触发一次 `mouseleave`——不防抖就会「一挪进面板就自己关掉」。120ms 足够穿过
   * 空隙，又短到不会被读成「卡住不关」。
   */
  const closeTimer = useRef<number | null>(null);
  const view = contextUsageView(
    usage,
    contextWindow,
    modelId ?? "",
    maxOutputTokens,
  );

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  }, [cancelClose]);

  // 卸载时清掉待触发的关闭（否则可能对已卸载组件 setState）
  useEffect(() => cancelClose, [cancelClose]);

  // 键盘可达：Tab 聚焦到环也展开，移开即收（面板里没有可聚焦控件，不需要额外处理）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    /* `inline-flex` 不能少：普通 div 会带上父级行高，环就比相邻图标**高 2px**（实测 cy 483 vs 485） */
    /* biome-ignore lint/a11y/noStaticElementInteractions: 这个 div 只是环与浮层的**命中盒**（悬停区域要跨过两者之间的空隙）；语义由里面的 button 承担，给它补一个 role 只会多一个说不出意义的节点、并和按钮的 `aria-label` 重复 */
    <div
      ref={containerRef}
      className="relative inline-flex items-center"
      /* 悬停展开（用户口径：「鼠标放上去悬浮显示，而不是点击才出来」）：
         环与面板都在这个容器里，指针移进面板仍算「没离开」，只有真的离开才排关闭 */
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => {
        cancelClose();
        setOpen(true);
      }}
      onBlur={scheduleClose}
    >
      <button
        type="button"
        aria-label="上下文容量"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={view.usageFineLine ?? view.usageLine ?? "上下文容量与缓存命中"}
        /* 悬停即展开，所以按下不再切换开合（点击时面板本来就是开的，再 toggle 会立刻关掉）。
           保留 button 是为了 Tab 可达与 aria-expanded 的语义 */
        /* 与相邻图标按钮同心中线（h-6 w-6 命中盒 + 居中，环本身 16）：
           圈不会跟图标错开半个像素；hover 只给底色（环的颜色不受悬停影响） */
        className="inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-muted"
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
          {/* 第一行：当前 / 窗口（两位小数百分比）——参考图的读数 + 用户口径的精确位 */}
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium">上下文容量</span>
            <span className="tabular-nums">
              {view.usageFineLine ?? view.usageLine ?? "本轮暂无用量"}
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
            {/* 命中率也画成进度条（用户口径：思考强度与缓存都要有进度条），
                颜色与上下文「已用」同一支蓝（用户口径：缓存条也要和上下文一样的蓝） */}
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-info"
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
 * 容量圆环（用户口径：**细环、不写数字、弧长必须和百分比对应**）。
 *
 * 读法：环画的是**已用掉的那一段**——几乎空环 = 上下文还很空，弧越满用得越多。
 * 第一版画的是「剩余」（缺口 = 已用），于是 4.5% 用量看起来像满环，用户当场否掉：
 * 「圆圈要和百分比对应！！！！而不是随便展示的」。
 *
 * 精确读数不放环里（环太小，两位数字挤不下），在 `title` 与浮层首行给
 * （`4.5万/100万（4.53%）`）。
 *
 * 越线（吃掉为输出预留的空间）时弧转琥珀色：那是「该收尾了」的信号，不是错误。
 * 没有用量数据时只画空环轨道（不编圆弧——「本轮暂无用量」时画出来的弧是假信息）。
 */
function ContextRing({
  percent,
  overThreshold = false,
}: {
  percent: number | null;
  overThreshold?: boolean;
}) {
  /**
   * 尺寸与粗细（用户口径收敛史：5px 厚环 → 2.5px/22px → 2.2px/18px → 16px/2px
   * → 现在 3px）：
   *
   * **加粗一律往里长**——半径取 `(size - stroke) / 2`，外沿因此恒在 16px 盒子的边上，
   * 环占地不变、只是内孔变小（`radius + stroke/2 = size/2`）。这也让它与相邻图标同心中线
   * 的判定不受粗细影响（改粗细不用重测对齐）。
   */
  const size = 16;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  /**
   * 弧 = **已用百分比**，与浮层里那个百分比是同一个数（用户口径：「圆圈要和百分比对应」）。
   *
   * 曾经把它画成「剩余」——4.5% 的用量看着像满环，跟浮层读数对不上，用户当场指出
   * 「不是随便展示的」。所以：**没有任何数据时只画空环**（不编圆弧），
   * 有数据就有多满画多满，越线（吃掉输出预留）转琥珀色。
   */
  const usedRatio =
    percent === null ? 0 : Math.min(100, Math.max(0, percent)) / 100;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      className="-rotate-90"
    >
      {/* 空环轨道：没有数据时看到的就是它（不画假圆弧） */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        className="stroke-border"
      />
      {percent !== null && usedRatio > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={`${circumference * usedRatio} ${circumference}`}
          className={
            overThreshold ? "stroke-amber-500" : "stroke-muted-foreground"
          }
        />
      ) : null}
    </svg>
  );
}
