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
  /** 上游上报的命中缓存输入 token；上游不报时为 undefined。 */
  cachedInputTokens?: number | undefined;
}

/**
 * 从 `run.usage` 事件载荷取用量快照。
 *
 * 没有 inputTokens（事件类型被服务端扩过、老服务端不发这个字段）时返回 null——
 * 页面保持原样，而不是把「0 token」当成真实读数写进状态。
 */
export function usageFromEvent(
  payload: unknown,
): RunUsageSnapshot | null {
  if (typeof payload !== "object" || payload === null) return null;
  const inputTokens = (payload as { inputTokens?: unknown }).inputTokens;
  if (typeof inputTokens !== "number") return null;
  const outputTokens = (payload as { outputTokens?: unknown }).outputTokens;
  const cached = (payload as { cachedInputTokens?: unknown }).cachedInputTokens;
  return {
    inputTokens,
    outputTokens: typeof outputTokens === "number" ? outputTokens : 0,
    ...(typeof cached === "number" ? { cachedInputTokens: cached } : {}),
  };
}

export interface ContextUsageView {
  /** 有可用用量数据（否则整个浮层只显示「暂无数据」）。 */
  hasUsage: boolean;
  /** 形如「61.4万」；无数据时为 null。 */
  inputLabel: string | null;
  /** 模型上下文窗口；未知时为 null（此时不显示百分比）。 */
  windowLabel: string | null;
  /** 占用百分比（0-100 的整数）；窗口未知或无数据时为 null。 */
  percent: number | null;
  /** 形如「61.4%」。 */
  percentLabel: string | null;
  /** 形如「99.9%」；上游未上报缓存时为 null。 */
  cacheHitLabel: string | null;
  outputLabel: string | null;
}

/** token 数的中文习惯缩写（参考图口径：61.4万 / 100万）。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 100_000_000) return `${trimZero(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${trimZero(value / 10_000)}万`;
  return String(Math.round(value));
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function contextUsageView(
  usage: RunUsageSnapshot | null | undefined,
  contextWindow: number | null | undefined,
): ContextUsageView {
  const empty: ContextUsageView = {
    hasUsage: false,
    inputLabel: null,
    windowLabel: null,
    percent: null,
    percentLabel: null,
    cacheHitLabel: null,
    outputLabel: null,
  };
  if (!usage || usage.inputTokens <= 0) return empty;

  const window =
    typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : null;
  const percent =
    window === null
      ? null
      : Math.min(100, Math.round((usage.inputTokens / window) * 1000) / 10);
  const cached = usage.cachedInputTokens;

  return {
    hasUsage: true,
    inputLabel: formatTokens(usage.inputTokens),
    windowLabel: window === null ? null : formatTokens(window),
    percent,
    percentLabel: percent === null ? null : `${percent}%`,
    // 上游没报缓存字段 → 不显示命中率（0% 会被读成「缓存全失效」）
    cacheHitLabel:
      typeof cached === "number" && cached >= 0
        ? `${Math.round((cached / usage.inputTokens) * 1000) / 10}%`
        : null,
    outputLabel: formatTokens(usage.outputTokens),
  };
}
