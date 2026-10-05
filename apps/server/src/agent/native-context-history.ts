import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { createDeepAgent } from "deepagents";
import type { AgentContextHistory } from "./context-history.js";
import {
  decodeNativeContextReference,
  encodeNativeContextReference,
} from "./native-context-reference.js";
import {
  createNativeManualCompaction,
  type NativeManualCompactionOptions,
} from "./native-manual-compaction.js";

/** 固定SDK的有效消息投影；关闭自动压缩仍须消费已提交的手动摘要。 */
export function effectiveNativeMessages(
  messages: BaseMessage[],
  state: object,
): BaseMessage[] {
  const value =
    "_summarizationEvent" in state ? state._summarizationEvent : undefined;
  if (value == null) return messages;
  if (typeof value !== "object")
    throw new Error("当前DA版本的摘要状态不完整。");
  const event = value as { cutoffIndex?: unknown; summaryMessage?: unknown };
  if (
    typeof event.cutoffIndex !== "number" ||
    !Number.isInteger(event.cutoffIndex) ||
    event.cutoffIndex < 0 ||
    event.cutoffIndex > messages.length ||
    !HumanMessage.isInstance(event.summaryMessage)
  )
    throw new Error("当前DA版本的摘要状态不完整。");
  return [event.summaryMessage, ...messages.slice(event.cutoffIndex)];
}

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
