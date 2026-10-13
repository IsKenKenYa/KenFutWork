import { randomUUID } from "node:crypto";
import type { StreamEvent } from "@kenfutwork/shared";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { countTokensApproximately } from "langchain";
import { z } from "zod";
import type { LocalActor } from "../features/local-instance/types.js";
import type { RunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";
import type { ModelCallUsage, ModelUsageOwner } from "./model-call-usage.js";
import { resolveInstanceModelExecution } from "./model-execution.js";
import { withStreamIdleGuard } from "./stream-idle-guard.js";

/** Private host port: a fresh, tool-free request, accounted to the owning Run. */
export interface ModelRequest {
  invocation: ModelInvocationSnapshot;
  system: string;
  input: string;
  remainingTokens: number | null;
}
export interface ModelRequestResult {
  text: string;
  hasToolCalls: boolean;
  usageObserved: boolean;
}
export type ModelRequestPort = (
  request: ModelRequest,
) => Promise<ModelRequestResult>;
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().safe(),
  output_tokens: z.number().int().nonnegative().safe(),
  input_token_details: z
    .object({ cache_read: z.number().int().nonnegative().safe().optional() })
    .optional(),
});

async function invokeModelRequest(
  messages: BaseMessage[],
  options: {
    model: BaseLanguageModel;
    owner: ModelUsageOwner;
    signal: AbortSignal;
    onUsage(usage: ModelCallUsage): Promise<void>;
  },
): Promise<{ result: unknown; usageObserved: boolean }> {
  const modelCallId = randomUUID();
  let usageObserved = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let acceptingUsage = true;
  const pending = options.model.invoke(messages, {
    runId: modelCallId,
    signal,
    callbacks: [
      {
        async handleLLMEnd(output) {
          if (!acceptingUsage || signal.aborted) return;
          const message = output.generations[0]?.[0];
          const native: unknown =
            message && "message" in message ? message.message : undefined;
          const parsed = usageSchema.safeParse(
            AIMessage.isInstance(native) ? native.usage_metadata : undefined,
          );
          if (!parsed.success) return;
          const usage = parsed.data;
          await options.onUsage({
            modelCallId,
            owner: options.owner,
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            ...(usage.input_token_details?.cache_read === undefined
              ? {}
              : { cachedInputTokens: usage.input_token_details.cache_read }),
          });
          usageObserved = true;
        },
      },
    ],
  });
  let result: unknown;
  try {
    const source: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: await pending }),
      }),
    };
    for await (const value of withStreamIdleGuard(source, {
      signal,
      idleMs: 60_000,
      onIdle: () => controller.abort(),
    })) {
      result = value;
      break;
    }
  } finally {
    acceptingUsage = false;
    controller.abort();
  }
  return { result, usageObserved };
}

export function createModelRequestPort(options: {
  resolve(invocation: ModelInvocationSnapshot): Promise<{
    model: BaseLanguageModel;
    owner: ModelUsageOwner;
    effectiveOutputTokens: number | null;
  }>;
  signal: AbortSignal;
  onUsage(usage: ModelCallUsage): Promise<void>;
}): ModelRequestPort {
  return async (request) => {
    options.signal.throwIfAborted();
    const execution = await options.resolve(request.invocation);
    const messages = [
      new SystemMessage(request.system),
      new HumanMessage(request.input),
    ];
    if (
      request.remainingTokens !== null &&
      (execution.effectiveOutputTokens === null ||
        countTokensApproximately(messages) + execution.effectiveOutputTokens >
          request.remainingTokens)
    )
      throw new Error("剩余目标预算不足以执行独立评估，请调整预算后恢复。");
    options.signal.throwIfAborted();
    const { result, usageObserved } = await invokeModelRequest(messages, {
      model: execution.model,
      owner: execution.owner,
      signal: options.signal,
      onUsage: options.onUsage,
    });
    options.signal.throwIfAborted();
    if (!AIMessage.isInstance(result))
      throw new Error("模型请求未返回助手结果。");
    // Recheck the frozen configuration after an asynchronous provider response.
    await options.resolve(request.invocation);
    options.signal.throwIfAborted();
    const content = result.content;
    return {
      text:
        typeof content === "string"
          ? content
          : content
              .map((part) =>
                typeof part === "string"
                  ? part
                  : part.type === "text"
                    ? part.text
                    : "",
              )
              .join(""),
      hasToolCalls:
        !!result.tool_calls?.length ||
        !!result.invalid_tool_calls?.length ||
        !!result.additional_kwargs.tool_calls?.length ||
        !!result.additional_kwargs.function_call,
      usageObserved,
    };
  };
}

/** Default Run-bound provider for the private request port. */
export function createRunModelRequestPort(options: {
  actor: LocalActor;
  runId: string;
  sessionId: string;
  threadId: string | undefined;
  signal: AbortSignal;
  providers: Parameters<typeof resolveInstanceModelExecution>[0]["providers"];
  catalog: Parameters<typeof resolveInstanceModelExecution>[0]["catalog"];
  usage: RunUsageAccumulator;
  assertCurrent(): void;
  publish(event: Extract<StreamEvent, { type: "run.usage" }>): Promise<void>;
  now(): string;
}): ModelRequestPort {
  return createModelRequestPort({
    signal: options.signal,
    resolve: (invocation) =>
      resolveInstanceModelExecution({
        actor: options.actor,
        specifier: `${invocation.providerId}:${invocation.modelId}`,
        invocation,
        providers: options.providers,
        catalog: options.catalog,
        headers: { sessionId: options.sessionId, threadId: options.threadId },
      }),
    onUsage: async (usage) => {
      options.assertCurrent();
      const owner = usage.owner;
      if (!owner) throw new Error("模型请求缺少可信用量归属。");
      const totals = options.usage.update(options.runId, usage.modelCallId, {
        provider: owner.provider,
        model: owner.model,
        ...(owner.providerInstanceId
          ? { providerInstanceId: owner.providerInstanceId }
          : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: usage.cachedInputTokens }),
        instanceId: options.actor.instanceId,
        accessClientId: options.actor.accessClientId,
      });
      await options.publish({
        type: "run.usage",
        runId: options.runId,
        modelCallId: usage.modelCallId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        runInputTokens: totals.inputTokens,
        runOutputTokens: totals.outputTokens,
        ...(usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: usage.cachedInputTokens }),
        ...(totals.cachedInputTokens === undefined
          ? {}
          : { runCachedInputTokens: totals.cachedInputTokens }),
        timestamp: options.now(),
      });
    },
  });
}
