import type { BaseLanguageModel } from "@langchain/core/language_models/base";

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
