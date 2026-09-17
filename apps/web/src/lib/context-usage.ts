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

import { resolveContextWindow } from "@kenfutwork/shared";

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
   *
   * **与各家上游字段的对照**（2026-09-17 联网核对，源见《改造计划》§4.13 用户第七批）：
   * - OpenAI `usage.prompt_tokens_details.cached_tokens`：**含在** prompt_tokens 里的命中量
   *   （文档只当命中指示，不给公式）——`cached ÷ prompt_tokens` 就是这里的算法；
   * - Anthropic `cache_read_input_tokens`（缓存里取到的输入）与 `input_tokens`（**未命中**
   *   的那部分）互斥，故其分母应是 input + cache_read + cache_creation；
   * - Google `usage.total_cached_tokens` = 命中缓存服务的 token 数；
   * - Langfuse 把各桶归一成互斥（`input` 排除 `input_cached_tokens`，`total` = 各桶之和）；
   * - LangChain（我们的采集处，见 `agent/stream-adapter.ts`）归一后 `input_tokens` 是**总**
   *   提示词、`input_token_details.cache_read` 是其中命中部分——分母即总量，无需按上游分叉。
   */
  cacheHitLabel: string | null;
  /** 命中率数值（0-100，供进度条用）；上游未上报时为 null。 */
  cacheHitPercent: number | null;
  /** 「平均」还是「本次调用」（老服务端只有单次数据时如实标注）。 */
  cacheHitScope: "run" | "call" | null;
  /**
   * 分类占比（按字符数降序，带百分比）。没有数据时为空数组——宁缺毋滥，
   * 不编一段「其他 100%」。百分比按各段字符数占合计算。
   */
  composition: Array<{ label: string; percent: number }>;
  outputLabel: string | null;
  /** 参考图那种「50.7万/100万（50.7%）」的整行读数。 */
  usageLine: string | null;
}

/** token 数的中文习惯缩写（参考图口径：61.4万 / 100万）。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 100_000_000) return `${trimZero(value / 100_000_000)}亿`;
  if (value >= 10_000) return `${trimZero(value / 10_000)}万`;
  return String(Math.round(value));
}

/**
 * 分类占比：按各段的**字符数占比**分摊本轮的**实际输入 token**。
 *
 * 口径（对齐参考图「消息 96.9% / 系统工具 2.2% …」的读法）：分母是模型这一次真正收到的
 * input tokens（上游给的数），各分类按自己那段字符数占的比例去分——所以各分类加起来正好
 * 是 100%，与「当前占用」那个百分比可以互相对照。上游不按分类给 token，故只能按字符分摊；
 * 这是估算，但分母是真的（不是「字符数占比」这种与窗口无关的数）。
 */
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
  /** 模型 id：窗口没声明时用它查常见模型兜底表（见 @kenfutwork/shared）。 */
  modelId = "",
): ContextUsageView {
  const window = resolveContextWindow(contextWindow, modelId);
  const empty: ContextUsageView = {
    hasUsage: false,
    inputLabel: null,
    windowKnown: window !== null,
    windowLabel: window === null ? null : formatTokens(window),
    percent: null,
    percentLabel: null,
    cacheHitLabel: null,
    cacheHitPercent: null,
    cacheHitScope: null,
    outputLabel: null,
    composition: [],
    usageLine: null,
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
    cacheHitPercent: hitRate === null ? null : Math.min(100, hitRate),
    cacheHitScope: hitRate === null ? null : useRunTotals ? "run" : "call",
    outputLabel: formatTokens(usage.outputTokens),
    composition: compositionView(usage.composition),
    // 参考图的读数：当前 / 窗口（百分比）。窗口未知时只给绝对量，不编百分比
    usageLine:
      window === null
        ? `${formatTokens(usage.inputTokens)}（窗口未知）`
        : `${formatTokens(usage.inputTokens)}/${formatTokens(window)}（${
            percent ?? 0
          }%）`,
  };
}
