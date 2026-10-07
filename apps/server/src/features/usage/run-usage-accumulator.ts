/**
 * run 用量累积器（agent 链路采集点，§4.5）：
 * stream-adapter 按 SDK modelCallId 更新调用累计绝对值；同一调用的 stream/end
 * 覆盖，不同调用相加。`turn-stopping` 事件监听器 take() 后按归属落账并清理。
 * 纯内存、按 runId 隔离；进程退出未结算的 run 用量即丢弃（观测旁路，不阻断主链路）。
 */

export interface RunUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface RunUsageEntry extends RunUsageTotals {
  provider: string;
  model: string;
  providerInstanceId?: string;
  instanceId: string;
  accessClientId?: string | null;
  costUsd?: number;
}

export interface RunUsageAccumulator {
  update(
    runId: string,
    modelCallId: string,
    entry: RunUsageEntry,
  ): RunUsageTotals;
  take(runId: string): RunUsageEntry[];
}

function requireId(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`[runUsage] ${name} must be non-empty`);
  }
}

function validateUsage(entry: RunUsageEntry): void {
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
  ] as const) {
    const value = entry[field];
    if (field === "cachedInputTokens" && value === undefined) continue;
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`[runUsage] ${field} must be a non-negative integer`);
    }
  }
  if (
    entry.costUsd !== undefined &&
    (!Number.isFinite(entry.costUsd) || entry.costUsd < 0)
  ) {
    throw new Error("[runUsage] costUsd must be finite and non-negative");
  }
}

function attributionKey(entry: RunUsageEntry): string {
  return JSON.stringify({
    provider: entry.provider,
    model: entry.model,
    providerInstanceId: entry.providerInstanceId,
    instanceId: entry.instanceId,
    accessClientId: entry.accessClientId,
  });
}

function addTotals(totals: RunUsageTotals, entry: RunUsageTotals): void {
  totals.inputTokens += entry.inputTokens;
  totals.outputTokens += entry.outputTokens;
  if (entry.cachedInputTokens !== undefined) {
    totals.cachedInputTokens =
      (totals.cachedInputTokens ?? 0) + entry.cachedInputTokens;
  }
}

export function createRunUsageAccumulator(): RunUsageAccumulator {
  const runs = new Map<string, Map<string, RunUsageEntry>>();
  return {
    update(runId, modelCallId, entry) {
      requireId(runId, "runId");
      requireId(modelCallId, "modelCallId");
      validateUsage(entry);
      const calls = runs.get(runId) ?? new Map<string, RunUsageEntry>();
      const previous = calls.get(modelCallId);
      if (previous && attributionKey(previous) !== attributionKey(entry)) {
        throw new Error("[runUsage] model call attribution must not change");
      }
      const next = { ...entry };
      if (
        next.cachedInputTokens === undefined &&
        previous?.cachedInputTokens !== undefined
      ) {
        next.cachedInputTokens = previous.cachedInputTokens;
      }
      if (next.costUsd === undefined && previous?.costUsd !== undefined) {
        next.costUsd = previous.costUsd;
      }
      calls.set(modelCallId, next);
      runs.set(runId, calls);
      const totals: RunUsageTotals = { inputTokens: 0, outputTokens: 0 };
      for (const call of calls.values()) addTotals(totals, call);
      return totals;
    },
    take(runId) {
      requireId(runId, "runId");
      const calls = runs.get(runId);
      runs.delete(runId);
      const buckets = new Map<string, RunUsageEntry>();
      for (const call of calls?.values() ?? []) {
        const key = attributionKey(call);
        const bucket = buckets.get(key);
        if (!bucket) {
          buckets.set(key, { ...call });
          continue;
        }
        addTotals(bucket, call);
        if (call.costUsd !== undefined) {
          bucket.costUsd = (bucket.costUsd ?? 0) + call.costUsd;
        }
      }
      return [...buckets.values()];
    },
  };
}
