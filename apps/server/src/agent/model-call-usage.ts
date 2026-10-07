import { z } from "zod";
import type { RunUsageTotals } from "../features/usage/run-usage-accumulator.js";

export const MODEL_USAGE_OWNER_METADATA = "kenfutwork_model_usage_owner";
const ownerSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  providerInstanceId: z.string().min(1).optional(),
  configRevision: z.number().int().nonnegative().optional(),
});
export type ModelUsageOwner = z.infer<typeof ownerSchema>;
export interface ModelCallUsage extends RunUsageTotals {
  modelCallId: string;
  owner?: ModelUsageOwner;
}
type ModelEvent = { run_id?: string; metadata?: Record<string, unknown> };
type UsageMessage = {
  usage_metadata?:
    | {
        input_tokens?: number | undefined;
        output_tokens?: number | undefined;
        input_token_details?: { cache_read?: number | undefined } | undefined;
      }
    | undefined;
};

/** SDK callback调用身份是边界；message ID和token大小均不替代它。 */
export function createModelCallUsageTracker() {
  const owners = new Map<string, ModelUsageOwner>();
  const calls = new Map<string, ModelCallUsage>();
  const published = new Map<string, string>();
  return {
    start(event: ModelEvent) {
      if (!event.run_id) return;
      const owner = ownerSchema.safeParse(
        event.metadata?.[MODEL_USAGE_OWNER_METADATA],
      );
      if (owner.success) owners.set(event.run_id, owner.data);
    },
    observe(event: ModelEvent, message: UsageMessage) {
      const usage = message.usage_metadata;
      if (!usage) return;
      const metrics = [
        usage.input_tokens,
        usage.output_tokens,
        usage.input_token_details?.cache_read,
      ];
      if (
        metrics.some(
          (value) =>
            value !== undefined && (!Number.isSafeInteger(value) || value < 0),
        )
      ) {
        console.warn("[model-usage] 模型用量不是非负安全整数，忽略该上报。");
        return;
      }
      const id = event.run_id;
      if (!id?.trim()) {
        console.warn("[model-usage] SDK调用身份缺失，拒绝猜测并计量。");
        return;
      }
      const old = calls.get(id);
      const owner = owners.get(id);
      const cached =
        usage.input_token_details?.cache_read ?? old?.cachedInputTokens;
      const next: ModelCallUsage = {
        modelCallId: id,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        ...(owner ? { owner } : {}),
      };
      calls.set(id, next);
      const key = JSON.stringify(next);
      // 仅真实用量变化可见；停止时可能没有end，不能遗漏最后一次观测。
      const emit = published.get(id) !== key;
      if (emit) published.set(id, key);
      const totals: RunUsageTotals = { inputTokens: 0, outputTokens: 0 };
      for (const call of calls.values()) {
        totals.inputTokens += call.inputTokens;
        totals.outputTokens += call.outputTokens;
        if (call.cachedInputTokens !== undefined)
          totals.cachedInputTokens =
            (totals.cachedInputTokens ?? 0) + call.cachedInputTokens;
      }
      return { usage: next, totals, emit };
    },
  };
}
