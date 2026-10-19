import { randomUUID } from "node:crypto";
import { resolveContextWindow, type StreamEvent } from "@kenfutwork/shared";
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
import type { ModelCatalogService } from "../features/model-providers/model-catalog-service.js";
import type { RunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import type { ModelInvocationSnapshot } from "../providers/types.js";
import { resolveInputTokenLimit } from "./auto-compact.js";
import type { ModelCallUsage, ModelUsageOwner } from "./model-call-usage.js";
import { resolveInstanceModelExecution } from "./model-execution.js";
import { assertNativeInputTokenLimit } from "./native-context-budget.js";
import { withStreamIdleGuard } from "./stream-idle-guard.js";

/** Private host port: a fresh, tool-free request, accounted to the owning Run. */
export interface ModelRequest {
  invocation: ModelInvocationSnapshot;
  system: string;
  input: string;
  remainingTokens: number | null;
  /** A caller can cancel its independent request without stopping the owning Run. */
  signal?: AbortSignal | undefined;
}
export interface ModelRequestResult {
  text: string;
  hasToolCalls: boolean;
  usageObserved: boolean;
  finishReason?: string | undefined;
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
    usageSignal: AbortSignal;
    onUsage(usage: ModelCallUsage): Promise<void>;
  },
): Promise<{ result: unknown; usageObserved: boolean }> {
  const modelCallId = randomUUID();
  let usageObserved = false;
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let usagePending: Promise<void> | undefined;
  const observeUsage = (native: unknown) => {
    // A superseded reviewer loses its decision, not a real receipt incurred by this live Run.
    if (options.usageSignal.aborted) return;
    if (usagePending) return usagePending;
    const parsed = usageSchema.safeParse(
      AIMessage.isInstance(native) ? native.usage_metadata : undefined,
    );
    if (!parsed.success) return;
    const usage = parsed.data;
    usagePending = Promise.resolve().then(async () => {
      options.usageSignal.throwIfAborted();
      await options.onUsage({
        modelCallId,
        owner: options.owner,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        ...(usage.input_token_details?.cache_read === undefined
          ? {}
          : { cachedInputTokens: usage.input_token_details.cache_read }),
      });
      if (!options.usageSignal.aborted) usageObserved = true;
    });
    return usagePending;
  };
  const pending = options.model
    .invoke(messages, {
      runId: modelCallId,
      signal,
      callbacks: [
        {
          async handleLLMEnd(output) {
            const generation = output.generations[0]?.[0];
            await observeUsage(
              generation && "message" in generation
                ? generation.message
                : undefined,
            );
          },
        },
      ],
    })
    .then(async (result) => {
      // SDK callbacks may run in the background; returned native usage is the same call's receipt.
      await observeUsage(result);
      return result;
    });
  // The caller can leave first; a late native usage callback still has an observed rejection.
  void pending.catch(() => {});
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
    controller.abort();
  }
  return { result, usageObserved };
}

export function createModelRequestPort(options: {
  resolve(invocation: ModelInvocationSnapshot): Promise<{
    model: BaseLanguageModel;
    owner: ModelUsageOwner;
    effectiveOutputTokens: number | null;
    inputTokenLimit: number | null;
  }>;
  signal: AbortSignal;
  onUsage(usage: ModelCallUsage): Promise<void>;
}): ModelRequestPort {
  return async (request) => {
    const signal = request.signal
      ? AbortSignal.any([options.signal, request.signal])
      : options.signal;
    signal.throwIfAborted();
    const execution = await options.resolve(request.invocation);
    const messages = [
      new SystemMessage(request.system),
      new HumanMessage(request.input),
    ];
    assertNativeInputTokenLimit(messages, null, execution.inputTokenLimit);
    if (
      request.remainingTokens !== null &&
      (execution.effectiveOutputTokens === null ||
        countTokensApproximately(messages) + execution.effectiveOutputTokens >
          request.remainingTokens)
    )
      throw new Error("剩余目标预算不足以执行独立评估，请调整预算后恢复。");
    signal.throwIfAborted();
    const { result, usageObserved } = await invokeModelRequest(messages, {
      model: execution.model,
      owner: execution.owner,
      signal,
      usageSignal: options.signal,
      onUsage: options.onUsage,
    });
    signal.throwIfAborted();
    if (!AIMessage.isInstance(result))
      throw new Error("模型请求未返回助手结果。");
    // Recheck the frozen configuration after an asynchronous provider response.
    await options.resolve(request.invocation);
    signal.throwIfAborted();
    const content = result.content;
    const finishReason =
      result.response_metadata?.finish_reason ??
      result.response_metadata?.stop_reason ??
      result.response_metadata?.finishReason;
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
      ...(typeof finishReason === "string" ? { finishReason } : {}),
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
  catalog:
    | Pick<ModelCatalogService, "validateSpecifier" | "listCatalog">
    | undefined;
  usage: RunUsageAccumulator;
  assertCurrent(): void;
  publish(event: Extract<StreamEvent, { type: "run.usage" }>): Promise<void>;
  now(): string;
}): ModelRequestPort {
  return createModelRequestPort({
    signal: options.signal,
    resolve: async (invocation) => {
      const execution = await resolveInstanceModelExecution({
        actor: options.actor,
        specifier: `${invocation.providerId}:${invocation.modelId}`,
        invocation,
        providers: options.providers,
        catalog: options.catalog,
        headers: { sessionId: options.sessionId, threadId: options.threadId },
      });
      const entries = options.catalog
        ? await options.catalog.listCatalog(options.actor)
        : [];
      const entry = entries.find(
        (item) =>
          item.provider.instanceId === invocation.providerId &&
          item.id === invocation.modelId,
      );
      return {
        ...execution,
        inputTokenLimit: resolveInputTokenLimit({
          contextWindow: resolveContextWindow(
            entry?.model.contextWindow,
            invocation.modelId,
          ),
          maxOutputTokens: execution.effectiveOutputTokens,
        }),
      };
    },
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
