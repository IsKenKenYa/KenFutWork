import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  type BaseMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { isCommand } from "@langchain/langgraph";
import type { BaseStore } from "@langchain/langgraph-checkpoint";
import {
  type createDeepAgent,
  createSummarizationMiddleware,
} from "deepagents";
import type { AgentMiddleware } from "langchain";
import type { CompactionPlan } from "./auto-compact.js";
import type { AgentBackendFactory } from "./backends/index.js";
import type { AgentContextHistory } from "./context-history.js";
import { createLlmRequestRetryMiddleware } from "./llm-retry-middleware.js";
import { nativeSummaryKey } from "./native-compaction.js";
import { encodeNativeContextReference } from "./native-context-reference.js";

export interface NativeManualCompactionOptions {
  model: BaseLanguageModel;
  backend: AgentBackendFactory;
  store?: BaseStore;
  plan: CompactionPlan;
  llmRetry: { maxAttempts: number; infinite: boolean };
}

/** 正式维护operation：原native完整消息不重建，只提交SDK实际生成的summary Command。 */
export function createNativeManualCompaction(
  options: NativeManualCompactionOptions & {
    agent: ReturnType<typeof createDeepAgent>;
  },
): AgentContextHistory["compactCurrent"] {
  return async ({ threadId, signal, onUsage }) => {
    signal?.throwIfAborted();
    const current = await options.agent.graph.getState({
      configurable: { thread_id: threadId },
    });
    const before = current.createdAt
      ? encodeNativeContextReference(threadId, current.config)
      : null;
    if (!before)
      return {
        status: "unchanged",
        reference: null,
        reason: "insufficient_history",
      };
    const checkpointId = current.config.configurable?.checkpoint_id;
    const namespace = current.config.configurable?.checkpoint_ns ?? "";
    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: namespace,
        checkpoint_id: checkpointId,
      },
    };
    const snapshot = await options.agent.graph.getState(config);
    const messages = (snapshot.values.messages ?? []) as BaseMessage[];
    const callbacks = [
      {
        name: "manual-compaction-usage",
        handleLLMEnd(output: LLMResult, modelCallId: string) {
          for (const generations of output.generations) {
            for (const generation of generations) {
              const message = (generation as { message?: unknown }).message;
              if (!AIMessage.isInstance(message)) continue;
              const usage = (
                message as unknown as {
                  usage_metadata?: {
                    input_tokens: number;
                    output_tokens: number;
                    input_token_details?: { cache_read?: number };
                  };
                }
              ).usage_metadata;
              if (!usage) continue;
              const cached = usage.input_token_details?.cache_read;
              onUsage?.({
                modelCallId,
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
              });
            }
          }
        },
      },
    ];
    const model = options.model.withConfig({
      ...(signal ? { signal } : {}),
      callbacks,
    });
    const middleware = createSummarizationMiddleware({
      backend: options.backend,
      // 0是单次control operation的force sentinel，非用户预算/限额，故不进入治理数值表。
      trigger: { type: "messages", value: 0 },
      keep: options.plan.keep,
    }) as unknown as AgentMiddleware;
    const hook = middleware.wrapModelCall;
    if (!hook) throw new Error("当前native adapter未提供手动压缩hook。");
    const request = {
      model,
      messages,
      state: snapshot.values,
      systemPrompt: "",
      systemMessage: new SystemMessage(""),
      tools: [],
      runtime: {
        context: {},
        configurable: { thread_id: threadId },
        signal,
        store: options.store,
      },
    } as Parameters<NonNullable<AgentMiddleware["wrapModelCall"]>>[0];
    const retry = createLlmRequestRetryMiddleware({
      ...options.llmRetry,
      ...(signal ? { signal } : {}),
    }).wrapModelCall;
    if (!retry) throw new Error("压缩模型重试治理未装配。");
    // 终端continuation的返回被SDK丢弃；不执行normal LLM、不写入任何消息/转录行。
    const summarize = () => hook(request, () => new AIMessage({ content: "" }));
    const result = await retry(request, summarize as never);
    signal?.throwIfAborted();
    if (!isCommand(result))
      return {
        status: "unchanged",
        reference: before,
        reason: "insufficient_history",
      };
    const update = Array.isArray(result.update)
      ? Object.fromEntries(result.update)
      : result.update;
    const expected = nativeSummaryKey(update?._summarizationEvent);
    if (!expected) throw new Error("native压缩没有返回实际summary更新。");
    const saved = await options.agent.graph.updateState(config, update);
    const reference = encodeNativeContextReference(threadId, saved);
    if (!reference) throw new Error("手动压缩未返回实际checkpoint引用。");
    const committed = await options.agent.graph.getState({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: saved.configurable?.checkpoint_ns ?? "",
        checkpoint_id: saved.configurable?.checkpoint_id,
      },
    });
    if (
      !committed.createdAt ||
      nativeSummaryKey(committed.values._summarizationEvent) !== expected
    )
      throw new Error("手动压缩summary未成为已提交checkpoint。");
    return { status: "applied", reference };
  };
}
