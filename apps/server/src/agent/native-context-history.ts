import type { BaseMessage } from "@langchain/core/messages";
import type { createDeepAgent } from "deepagents";
import type { AgentContextHistory } from "./context-history.js";
import { effectiveNativeMessages } from "./native-compaction.js";
import {
  decodeNativeContextReference,
  encodeNativeContextReference,
} from "./native-context-reference.js";
import {
  createNativeManualCompaction,
  type NativeManualCompactionOptions,
} from "./native-manual-compaction.js";

export { effectiveNativeMessages } from "./native-compaction.js";

/** 固定DA版本的公开graph适配；_summarizationEvent仅在adapter内重建有效输入。 */
export function createNativeContextHistory(
  agent: ReturnType<typeof createDeepAgent>,
  operations: NativeManualCompactionOptions,
): AgentContextHistory {
  return {
    compactCurrent: createNativeManualCompaction({ agent, ...operations }),
    async captureCurrentReference(threadId) {
      const snapshot = await agent.graph.getState({
        configurable: { thread_id: threadId },
      });
      if (!snapshot.createdAt) return null;
      return encodeNativeContextReference(threadId, snapshot.config);
    },
    async getEffectiveState(reference) {
      const key = decodeNativeContextReference(reference);
      const snapshot = await agent.graph.getState({
        configurable: {
          thread_id: key.threadId,
          checkpoint_ns: key.namespace,
          checkpoint_id: key.checkpointId,
        },
      });
      if (
        !snapshot.createdAt ||
        snapshot.config.configurable?.checkpoint_id !== key.checkpointId
      )
        throw new Error("已记录的上下文checkpoint不可用。");
      const state = snapshot.values as {
        messages?: BaseMessage[];
        _summarizationEvent?: unknown;
      };
      const messages = state.messages ?? [];
      const event = state._summarizationEvent;
      const effective = effectiveNativeMessages(messages, state);
      return {
        messages: effective.map((message) => ({
          id: message.id ?? null,
          type: message.getType(),
          content: structuredClone(message.content),
          summary: !!event && message === effective[0],
        })),
      };
    },
  };
}
