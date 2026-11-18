import { loadBundledModelsDevSnapshot } from "./models-dev-bundled.js";
import { findModelsDevModel } from "./models-dev-snapshot.js";

/** 目录里的价格单位是「美元 / 百万 token」。 */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

let cachedSnapshot: ReturnType<typeof loadBundledModelsDevSnapshot> | undefined;
let snapshotLoaded = false;

function bundledSnapshot(): ReturnType<typeof loadBundledModelsDevSnapshot> {
  if (!snapshotLoaded) {
    cachedSnapshot = loadBundledModelsDevSnapshot();
    snapshotLoaded = true;
  }
  return cachedSnapshot;
}

/**
 * 用随包发布的 models.dev 目录估算一次模型调用花费（美元）。
 *
 * 只在供应商没有回传成本时兜底：目录命中且带 input/output 价格才算，
 * 未知模型或缺价格返回 undefined（界面继续显示「未统计」，不拿 0 冒充）。
 * 缓存读取 token 从输入 token 里扣除，按 `cache_read` 单价计；目录没有该单价时
 * 退回普通输入单价。
 */
export function estimateModelCostUsd(
  modelId: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  },
  preferredProvider?: string,
): number | undefined {
  if (!modelId || modelId === "unknown") return undefined;
  const snapshot = bundledSnapshot();
  if (!snapshot) return undefined;
  const cost = findModelsDevModel(snapshot, modelId, preferredProvider)?.model
    .cost;
  const inputPrice = cost?.input;
  const outputPrice = cost?.output;
  if (
    typeof inputPrice !== "number" ||
    typeof outputPrice !== "number" ||
    !Number.isFinite(inputPrice) ||
    !Number.isFinite(outputPrice)
  ) {
    return undefined;
  }
  const cachedTokens = Math.min(
    Math.max(tokens.cachedInputTokens ?? 0, 0),
    Math.max(tokens.inputTokens, 0),
  );
  const uncachedTokens = Math.max(tokens.inputTokens - cachedTokens, 0);
  const cacheReadPrice =
    typeof cost?.cache_read === "number" && Number.isFinite(cost.cache_read)
      ? cost.cache_read
      : inputPrice;
  const totalUsd =
    (uncachedTokens * inputPrice +
      cachedTokens * cacheReadPrice +
      Math.max(tokens.outputTokens, 0) * outputPrice) /
    TOKENS_PER_PRICE_UNIT;
  return Number.isFinite(totalUsd) ? totalUsd : undefined;
}
