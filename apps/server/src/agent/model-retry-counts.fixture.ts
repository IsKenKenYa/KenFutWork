import { randomUUID } from "node:crypto";
import type { ModelCallPurpose, StreamEvent } from "@kenfutwork/shared";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { loadServerEnv } from "../config/env.js";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";
import { createReadHistoryTool } from "../features/context-history/read-history-tool.js";
import {
  createContextHistoryArchiveBindings,
  requireContextHistoryPageBudget,
} from "../features/context-history/service.js";
import { archiveTaskFixture } from "../features/context-history/test-fixture.js";
import { createRunUsageAccumulator } from "../features/usage/run-usage-accumulator.js";
import { resolveCompactionPlan } from "./auto-compact.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";
import { resolveInstanceModelExecution } from "./model-execution.js";
import { createRunModelRequestPort } from "./model-request.js";

export async function modelRetryFixture(
  rejected: readonly number[],
  failure = { status: 503, code: "temporarily_unavailable" },
) {
  const task = await archiveTaskFixture();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(15000),
  ]);
  let notify!: () => void;
  let requestHook: ((index: number) => void) | undefined;
  let configRevision = 1;
  const nextRequest = () =>
    new Promise<void>((resolve) => {
      notify = resolve;
    });
  let changed = nextRequest();
  const provider = await heldModel({
    rejectStatus: failure.status,
    rejectError: { message: "供应商拒绝本次请求", code: failure.code },
    rejectRequestIndexes: rejected,
    onRequest: (index) => {
      notify();
      requestHook?.(index);
    },
    usage: { promptTokens: 31, completionTokens: 4 },
  });
  const providerId = randomUUID();
  const runId = randomUUID();
  const threadId = randomUUID();
  const invocation = {
    providerId,
    modelId: "retry-model",
    configRevision: 1,
    useResponsesApi: false,
    body: { max_tokens: 100 },
    inputCapabilities: { image: false, pdf: false },
  };
  const providers = {
    resolveCredentials: async () => ({
      instanceId: providerId,
      name: "本机测试供应商",
      protocol: "openai-compatible" as const,
      baseUrl: provider.baseUrl,
      apiKey: "local-test-key",
      configRevision,
      models: [],
    }),
  };
  const starts: { id: string; purpose: ModelCallPurpose }[] = [];
  const errors: string[] = [];
  const ends: string[] = [];
  const callbacks = (purpose: ModelCallPurpose) => [
    Object.assign(
      BaseCallbackHandler.fromMethods({
        handleChatModelStart(_model, _messages, id) {
          starts.push({ id, purpose });
        },
        handleLLMError(_error, id) {
          errors.push(id);
        },
        handleLLMEnd(_output, id) {
          ends.push(id);
        },
      }),
      { awaitHandlers: true, raiseError: true },
    ),
  ];
  const usage = createRunUsageAccumulator();
  const published: StreamEvent[] = [];
  let consumed = 0;
  return {
    task,
    provider,
    signal,
    starts,
    errors,
    ends,
    usage,
    runId,
    published,
    request: {
      invocation,
      system: "评估规则",
      input: "实际任务证据",
      remainingTokens: null,
    },
    onRequest(hook: (index: number) => void) {
      requestHook = hook;
    },
    reviseProvider() {
      configRevision++;
    },
    port(maxAttempts: number, publish?: (event: StreamEvent) => Promise<void>) {
      return createRunModelRequestPort({
        actor: task.actor,
        runId,
        sessionId: task.identity.taskId,
        threadId,
        signal,
        providers,
        catalog: undefined,
        usage,
        llmRetry: { maxAttempts, infinite: false },
        assertCurrent: () => signal.throwIfAborted(),
        now: () => new Date().toISOString(),
        publish: async (event) => {
          published.push(event);
          await publish?.(event);
        },
        createModelCallbacks: callbacks,
      });
    },
    async agent(
      maxAttempts: number,
      mode: "agent" | "automatic" | "manual",
      observe = true,
    ) {
      const execution = await resolveInstanceModelExecution({
        actor: task.actor,
        specifier: `${providerId}:retry-model`,
        invocation,
        providers,
        headers: { sessionId: task.identity.taskId, threadId },
      });
      const archives = createContextHistoryArchiveBindings();
      return createKenFutWorkDeepAgent({
        env: loadServerEnv({}, {}),
        preset: "code",
        model: execution.model,
        systemPrompt: "处理真实任务",
        checkpointer: new MemorySaver(),
        backendResult: {
          factory: () => task.handle.backend,
          sandboxDir: task.identity.rootDirectory,
          ephemeral: false,
        },
        runToolContext: { ...task.execution, threadId },
        contextHistoryArchives: archives,
        kernelTools: [
          createReadHistoryTool(
            archives,
            requireContextHistoryPageBudget(task.handle),
          ),
        ],
        llmRetry: { maxAttempts, infinite: false },
        ...(mode === "automatic"
          ? {
              autoCompact: resolveCompactionPlan({
                contextWindow: 10000,
                retention: {
                  compactKeepMessages: 4,
                  compactFallbackKeepMessages: 4,
                },
              }),
            }
          : {}),
        ...(mode === "manual"
          ? {
              manualCompactPlan: {
                trigger: { type: "tokens" as const, value: 1 },
                keep: { type: "messages" as const, value: 4 },
                source: "fraction" as const,
              },
            }
          : {}),
        runExtensions: observe
          ? [
              {
                preset: "shared",
                createMiddleware: () => ({ name: "RetryCountObserver" }),
                createModelCallbacks: (
                  _identity,
                  _context,
                  purpose = "agent",
                ) => callbacks(purpose),
              },
            ]
          : [],
      });
    },
    threadConfig: {
      version: "v2" as const,
      signal,
      configurable: { thread_id: threadId },
    },
    async drive<T>(pending: Promise<T>): Promise<PromiseSettledResult<T>> {
      let settled = false;
      const done = pending.then(
        (value): PromiseFulfilledResult<T> => {
          settled = true;
          return { status: "fulfilled", value };
        },
        (reason): PromiseRejectedResult => {
          settled = true;
          return { status: "rejected", reason };
        },
      );
      while (!settled) {
        await Promise.race([changed, done]);
        changed = nextRequest();
        while (consumed < provider.requests.length) {
          const index = consumed++;
          if (!rejected.includes(index)) provider.finish(index);
        }
      }
      return done;
    },
    async close() {
      controller.abort();
      await provider.close();
      await task.cleanup();
    },
  };
}

export function retryHistory() {
  return Array.from({ length: 20 }, (_, index) =>
    index % 2
      ? new AIMessage(index < 10 ? "历史操作".repeat(3000) : `答复${index}`)
      : new HumanMessage(index < 10 ? "真实任务".repeat(3000) : `问题${index}`),
  );
}

export async function consumeRetryEvents(source: AsyncIterable<unknown>) {
  for await (const event of source) void event;
}
