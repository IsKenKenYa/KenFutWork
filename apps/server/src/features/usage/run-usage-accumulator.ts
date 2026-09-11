/**
 * run 用量累积器（agent 链路采集点，§4.5）：
 * stream-adapter 在 LangChain chunk 中读到 usage_metadata 时更新（cumulative 语义，
 * 每次覆盖为最新累计值）；`turn-stopping` 事件监听器 take() 后落账并清理。
 * 纯内存、按 runId 隔离；进程退出未结算的 run 用量即丢弃（观测旁路，不阻断主链路）。
 */

export interface RunUsageEntry {
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  providerInstanceId?: string;
  userId: string;
}

export interface RunUsageAccumulator {
  update(runId: string, entry: RunUsageEntry): void;
  take(runId: string): RunUsageEntry | undefined;
}

export function createRunUsageAccumulator(): RunUsageAccumulator {
  const entries = new Map<string, RunUsageEntry>();
  return {
    update(runId, entry) {
      entries.set(runId, entry);
    },
    take(runId) {
      const entry = entries.get(runId);
      entries.delete(runId);
      return entry;
    },
  };
}
