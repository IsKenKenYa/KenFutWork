import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { BaseMessage } from "@langchain/core/messages";
import { countTokensApproximately } from "langchain";

/** Shared SDK estimate over the complete request, including tool definitions when present. */
export function assertNativeInputTokenLimit(
  messages: BaseMessage[],
  tools: Parameters<typeof countTokensApproximately>[1],
  limit: unknown,
) {
  if (limit === undefined || limit === null) return;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("模型输入预算无效，请检查模型设置。");
  if (countTokensApproximately(messages, tools?.length ? tools : null) > limit)
    throw new Error("上下文估算超出模型输入预算，请调整模型或保留设置。");
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Fixed native SDK adapter: inspect actual invocation parameters, never catalog capacity or character counts. */
export function nativeEffectiveOutputTokens(
  model: BaseLanguageModel,
): number | null {
  if (
    !("invocationParams" in model) ||
    typeof model.invocationParams !== "function"
  )
    return null;
  const parameters: unknown = model.invocationParams.call(model);
  if (!record(parameters))
    throw new Error("模型请求预算解析失败，请检查模型设置。");
  const generation = record(parameters.generationConfig)
    ? parameters.generationConfig
    : undefined;
  const limits = [
    parameters.max_tokens,
    parameters.max_completion_tokens,
    parameters.max_output_tokens,
    generation?.maxOutputTokens,
  ].filter((value) => value !== undefined && value !== null);
  if (!limits.length) return null;
  if (
    limits.some(
      (value) =>
        typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0,
    )
  )
    throw new Error("模型实际输出上限无效，请检查模型设置。");
  const values = limits.filter(
    (value): value is number => typeof value === "number",
  );
  if (new Set(values).size !== 1)
    throw new Error("模型输出上限冲突，请检查模型设置。");
  return values[0] ?? null;
}
