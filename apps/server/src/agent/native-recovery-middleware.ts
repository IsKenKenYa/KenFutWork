import { AsyncLocalStorage } from "node:async_hooks";
import {
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getConfig, isCommand } from "@langchain/langgraph";
import {
  type BackendProtocolV2,
  createSummarizationMiddleware,
  StateBackend,
} from "deepagents";
import type { AgentMiddleware } from "langchain";
import {
  type NativeArchiveBinding,
  type NativeCheckpointArchive,
  nativeArchivePrefix,
} from "./native-checkpoint-archive.js";
import { assertNativeInputTokenLimit } from "./native-context-budget.js";
import { recoverySummaryPrompt } from "./native-recovery-summary.js";

type NativeRequest = Parameters<
  NonNullable<AgentMiddleware["wrapModelCall"]>
>[0];

/** Shared SDK counter at the actual model boundary, independent of the earlier summary trigger. */
export function assertNativeContextInputBudget(
  messages: BaseMessage[],
  tools: NativeRequest["tools"],
  model: NativeRequest["model"],
  inputTokenLimit?: () => number | null,
) {
  const configured = inputTokenLimit?.();
  const profile = "profile" in model ? model.profile : undefined;
  const profileLimit =
    profile && typeof profile === "object" && "maxInputTokens" in profile
      ? profile.maxInputTokens
      : undefined;
  const limit = configured ?? profileLimit;
  assertNativeInputTokenLimit(messages, tools, limit);
}

/** Keep native trigger/keep/counting. Never commit a summary after failed SDK offload. */
export function createNativeRecoveryMiddleware(
  options: Parameters<typeof createSummarizationMiddleware>[0] & {
    archive?: NativeCheckpointArchive;
    archiveConfig?: () => RunnableConfig;
    inputTokenLimit?: () => number | null;
  },
): AgentMiddleware {
  const bindings = new AsyncLocalStorage<{
    binding: NativeArchiveBinding;
    signal?: AbortSignal;
    failure?: unknown;
  }>();
  const verifyArchive = async (
    binding: NativeArchiveBinding,
    signal?: AbortSignal,
  ) => {
    if (!options.archive) throw new Error("历史归档未装配。");
    await options.archive.read({
      reference: binding.reference,
      limit: 1,
      ...(signal ? { signal } : {}),
    });
  };
  const archiveBackend: BackendProtocolV2 = new StateBackend();
  // This sink publishes a receipt for already durable native messages. It is never a tool backend.
  archiveBackend.downloadFiles = async (paths) =>
    paths.map((path) => ({
      path,
      content: null,
      error: "file_not_found" as const,
    }));
  archiveBackend.write = async (path) => {
    const active = bindings.getStore();
    if (!active || path !== active.binding.uri || !options.archive)
      return { error: "历史归档引用不匹配。" };
    try {
      await verifyArchive(active.binding, active.signal);
    } catch (error) {
      active.failure = error;
      throw error;
    }
    return { path };
  };
  const middleware = createSummarizationMiddleware({
    ...options,
    summaryPrompt: recoverySummaryPrompt,
    ...(options.archive
      ? { backend: archiveBackend, historyPathPrefix: nativeArchivePrefix }
      : {}),
  }) as unknown as AgentMiddleware;
  const wrap = middleware.wrapModelCall;
  if (!wrap) throw new Error("当前native adapter未提供压缩hook。");
  return {
    ...middleware,
    async wrapModelCall(request, handler) {
      const run = async (boundRequest: typeof request) => {
        const result = await wrap(boundRequest, async (next) => {
          const first = next.messages[0];
          const previous = (
            "_summarizationEvent" in request.state
              ? request.state._summarizationEvent
              : undefined
          ) as { summaryMessage?: unknown } | undefined;
          if (
            HumanMessage.isInstance(first) &&
            first !== previous?.summaryMessage &&
            first.additional_kwargs.lc_source === "summarization" &&
            typeof first.content === "string" &&
            first.content.startsWith(
              "Here is a summary of the conversation to date:",
            )
          )
            throw new Error("历史归档失败，未提交压缩摘要。");
          const active = bindings.getStore();
          if (active && options.archive)
            await verifyArchive(active.binding, active.signal);
          assertNativeContextInputBudget(
            SystemMessage.isInstance(next.systemMessage)
              ? [next.systemMessage, ...next.messages]
              : next.messages,
            next.tools,
            next.model,
            options.inputTokenLimit,
          );
          return handler(next);
        });
        if (isCommand(result)) {
          const update = Array.isArray(result.update)
            ? Object.fromEntries(result.update)
            : result.update;
          const event = update?._summarizationEvent;
          if (
            event &&
            (typeof event !== "object" ||
              !("filePath" in event) ||
              !event.filePath)
          )
            throw new Error("历史归档失败，未提交压缩摘要。");
          const active = bindings.getStore();
          if (event && active && options.archive)
            await verifyArchive(active.binding, active.signal);
        }
        return result;
      };
      if (!options.archive) return run(request);
      const signal = request.runtime.signal;
      const binding = await options.archive.bind({
        config: options.archiveConfig?.() ?? getConfig(),
        messages: request.state.messages,
        ...(signal ? { signal } : {}),
      });
      const active = {
        binding,
        ...(signal ? { signal } : {}),
        failure: undefined as unknown,
      };
      // SDK swallows offload errors; prevent it from sending revoked/unreadable history to the summary model.
      const model = new Proxy(request.model, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "invoke")
            return async (...args: Parameters<typeof target.invoke>) => {
              if (active.failure) throw active.failure;
              signal?.throwIfAborted();
              await verifyArchive(binding, signal);
              const input = args[0];
              if (Array.isArray(input)) {
                const messages = input.filter(BaseMessage.isInstance);
                if (messages.length === input.length)
                  assertNativeContextInputBudget(
                    messages,
                    [],
                    target,
                    options.inputTokenLimit,
                  );
              }
              return target.invoke(...args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const state = Object.assign({}, request.state, {
        _summarizationSessionId: binding.sessionId,
      });
      return bindings.run(active, () => run({ ...request, model, state }));
    },
  };
}
