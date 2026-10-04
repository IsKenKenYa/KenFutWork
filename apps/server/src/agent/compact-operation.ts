import type { StreamEvent } from "@kenfutwork/shared";
import type { CompactionPlan } from "./auto-compact.js";
import type {
  AgentContextHistory,
  AgentOperationUsage,
} from "./context-history.js";

/** 共用Harness里的维护operation事件；不产生message事件或伪造用户转录。 */
export async function* streamCompactOperation(options: {
  history: AgentContextHistory;
  threadId: string;
  runId: string;
  sessionId: string;
  conversationId: string;
  plan: CompactionPlan;
  signal: AbortSignal;
  now: () => string;
  onUsage?: (usage: AgentOperationUsage) => void;
}): AsyncGenerator<StreamEvent> {
  yield {
    type: "run.started",
    runId: options.runId,
    sessionId: options.sessionId,
    conversationId: options.conversationId,
    timestamp: options.now(),
  };
  const usages: AgentOperationUsage[] = [];
  const result = await options.history.compactCurrent({
    threadId: options.threadId,
    signal: options.signal,
    onUsage: (usage) => {
      usages.push(usage);
      options.onUsage?.(usage);
    },
  });
  for (const usage of usages)
    yield {
      type: "run.usage",
      runId: options.runId,
      ...usage,
      timestamp: options.now(),
    };
  if (result.status === "applied")
    yield {
      type: "run.compacted",
      origin: "manual",
      runId: options.runId,
      keepMessages: options.plan.keep.value,
      timestamp: options.now(),
    };
  yield {
    type: "run.completed",
    runId: options.runId,
    timestamp: options.now(),
    operationResult: {
      kind: "compact",
      origin: "manual",
      status: result.status,
      ...(result.status === "unchanged" ? { reason: result.reason } : {}),
    },
  };
}
