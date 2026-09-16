/**
 * 「上下文容量 / 缓存命中」浮层的展示口径（R4-1）。
 *
 * 数据只有一个来源：服务端 `run.usage` 事件（见 packages/shared/src/events.ts），
 * 值是**本轮最后一次模型调用**的累计用量。模型上下文窗口来自模型目录
 * （`modelInfoSchema.contextWindow`），客户端只做除法与格式化。
 *
 * 为什么单独抽出来：三件事都要被钉住——① 没有数据时不能显示 0%；
 * ② 上游没报缓存字段时不能拿 0 冒充命中率；③ 窗口未知时不能编一个分母。
 */

export interface RunUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  /** 上游上报的**本次调用**命中缓存输入 token；上游不报时为 undefined。 */
  cachedInputTokens?: number | undefined;
  /** 本轮 run 累计输入 token（跨模型调用求和）；老服务端不发的字段。 */
  runInputTokens?: number | undefined;
  /** 本轮 run 累计命中缓存输入 token；一次都没上报时为 undefined。 */
  runCachedInputTokens?: number | undefined;
  /** 上下文容量的分类占比（字符数口径）；老服务端不带这个字段。 */
  composition?: Array<{ label: string; chars: number }> | undefined;
}

/**
 * 从 `run.usage` 事件载荷取用量快照。
 *
 * 没有 inputTokens（事件类型被服务端扩过、老服务端不发这个字段）时返回 null——
 * 页面保持原样，而不是把「0 token」当成真实读数写进状态。
 */
export function usageFromEvent(payload: unknown): RunUsageSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const inputTokens = (payload as { inputTokens?: unknown }).inputTokens;
  if (typeof inputTokens !== "number") return null;
  const outputTokens = (payload as { outputTokens?: unknown }).outputTokens;
  const cached = (payload as { cachedInputTokens?: unknown }).cachedInputTokens;
  const runInput = (payload as { runInputTokens?: unknown }).runInputTokens;
  const runCached = (payload as { runCachedInputTokens?: unknown })
    .runCachedInputTokens;
  const parts = (payload as { composition?: unknown }).composition;
  return {
    inputTokens,
    outputTokens: typeof outputTokens === "number" ? outputTokens : 0,
    ...(Array.isArray(parts)
      ? {
          composition: parts.flatMap((part) =>
            part &&
            typeof part === "object" &&
            typeof (part as { label?: unknown }).label === "string" &&
            typeof (part as { chars?: unknown }).chars === "number"
              ? [
                  {
                    label: (part as { label: string }).label,
                    chars: (part as { chars: number }).chars,
                  },
                ]
              : [],
          ),
        }
      : {}),
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
    ...(typeof runInput === "number" ? { runInputTokens: runInput } : {}),
    ...(typeof runCached === "number"
      ? { runCachedInputTokens: runCached }
      : {}),
  };
}

export interface ContextUsageView {
  /** 有可用用量数据（否则整个浮层只显示「暂无数据」）。 */
  hasUsage: boolean;
  /** 形如「61.4万」；无数据时为 null。 */
  inputLabel: string | null;
  /**
   * 模型目录是否声明了上下文窗口。
   *
   * 与 `hasUsage` **解耦**：本轮没有用量时窗口照样可能是已知的，
   * 不能因为「没数据」就写「该模型没有声明上下文窗口」（曾这么错过一次——
   * 文案把两件事混成一件，用户会以为模型目录缺字段）。
   */
  windowKnown: boolean;
  /** 模型上下文窗口；未知时为 null（此时不显示百分比）。 */
  windowLabel: string | null;
  /** 占用百分比（0-100 的整数）；窗口未知或无数据时为 null。 */
  percent: number | null;
  /** 形如「61.4%」。 */
  percentLabel: string | null;
  /**
   * 平均缓存命中率（形如「99.9%」）。
   *
   * **口径**：累计命中缓存输入 ÷ 累计输入（按 token 加权，跨本轮所有模型调用求和）。
   * 不是各次调用百分比的算术平均——那样短调用权重过大，会把命中率算虚高。
   * 上游一次都没报缓存字段时为 null（显示「上游未上报」，不拿 0 冒充）。
   * 服务端没带累计字段（老版本）时退回「本次调用」的单次命中率并标注。
   */
  cacheHitLabel: string | null;
  /** 「平均」还是「本次调用」（老服务端只有单次数据时如实标注）。 */
  cacheHitScope: "run" | "call" | null;
  /**
   * 分类占比（按字符数降序，带百分比）。没有数据时为空数组——宁缺毋滥，
   * 不编一段「其他 100%」。百分比按各段字符数占合计算。
   */
  composition: Array<{ label: string; percent: number }>;
  outputLabel: string | null;
}

/** token 数的中文习惯缩写（参考图口径：61.4万 / 100万）。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 100_000_000) return `${trimZero(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${trimZero(value / 10_000)}万`;
  return String(Math.round(value));
}

/** 分类占比：字符数 → 百分比（一位小数），降序；无数据返回空数组。 */
function compositionView(
  parts: Array<{ label: string; chars: number }> | undefined,
): Array<{ label: string; percent: number }> {
  if (!parts || parts.length === 0) return [];
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.chars), 0);
  if (total <= 0) return [];
  return [...parts]
    .map((part) => ({
      label: part.label,
      percent: Math.round((Math.max(0, part.chars) / total) * 1000) / 10,
    }))
    .sort((a, b) => b.percent - a.percent);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function contextUsageView(
  usage: RunUsageSnapshot | null | undefined,
  contextWindow: number | null | undefined,
): ContextUsageView {
  const window =
    typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : null;
  const empty: ContextUsageView = {
    hasUsage: false,
    inputLabel: null,
    windowKnown: window !== null,
    windowLabel: window === null ? null : formatTokens(window),
    percent: null,
    percentLabel: null,
    cacheHitLabel: null,
    cacheHitScope: null,
    outputLabel: null,
    composition: [],
  };
  if (!usage || usage.inputTokens <= 0) return empty;

  const percent =
    window === null
      ? null
      : Math.min(100, Math.round((usage.inputTokens / window) * 1000) / 10);
  const cached = usage.cachedInputTokens;
  const runInput = usage.runInputTokens;
  const runCached = usage.runCachedInputTokens;

  // 累计口径优先（平均命中率需要分母 = 整轮输入）；服务端没带就退回单次并标注口径
  const useRunTotals =
    typeof runInput === "number" &&
    runInput > 0 &&
    typeof runCached === "number" &&
    runCached >= 0;
  const singleKnown = typeof cached === "number" && cached >= 0;
  const hitRate = useRunTotals
    ? (runCached / runInput) * 100
    : singleKnown
      ? (cached / usage.inputTokens) * 100
      : null;

  return {
    hasUsage: true,
    inputLabel: formatTokens(usage.inputTokens),
    windowKnown: window !== null,
    windowLabel: empty.windowLabel,
    percent,
    percentLabel: percent === null ? null : `${percent}%`,
    // 上游没报缓存字段 → 不显示命中率（0% 会被读成「缓存全失效」）
    cacheHitLabel:
      hitRate === null ? null : `${Math.round(hitRate * 10) / 10}%`,
    cacheHitScope: hitRate === null ? null : useRunTotals ? "run" : "call",
    outputLabel: formatTokens(usage.outputTokens),
    composition: compositionView(usage.composition),
  };
}
