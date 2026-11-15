import { randomUUID } from "node:crypto";
import type { ModelCallPurpose } from "@kenfutwork/shared";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { expect, it, vi } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";
import { createReadHistoryTool } from "../features/context-history/read-history-tool.js";
import {
  createContextHistoryArchiveBindings,
  requireContextHistoryPageBudget,
} from "../features/context-history/service.js";
import { archiveTaskFixture } from "../features/context-history/test-fixture.js";
import { createInstanceChatModel } from "../providers/openai-compatible/index.js";
import { resolveCompactionPlan } from "./auto-compact.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";

function observedExtension(
  owner: string,
  starts: {
    owner: string;
    purpose: ModelCallPurpose;
    id: string;
    messages: BaseMessage[][];
  }[],
  ends: string[],
) {
  return {
    preset: "shared" as const,
    createMiddleware: () => ({ name: "CompactionObserver" }),
    createModelCallbacks(
      _identity: unknown,
      _context: unknown,
      purpose: ModelCallPurpose = "agent",
    ) {
      const observer = BaseCallbackHandler.fromMethods({
        handleChatModelStart(_model, messages, id) {
          starts.push({ owner, purpose, id, messages });
        },
        handleLLMEnd(_output, id) {
          ends.push(id);
        },
      });
      observer.awaitHandlers = true;
      return [observer];
    },
  };
}
const history = () =>
  Array.from({ length: 20 }, (_, index) =>
    index % 2
      ? new AIMessage(index < 10 ? "历史操作".repeat(3000) : `答复${index}`)
      : new HumanMessage(index < 10 ? "真实任务".repeat(3000) : `问题${index}`),
  );
async function consume(source: AsyncIterable<unknown>) {
  for await (const event of source) void event;
}

it("自动摘要保留外部回调，每个真实请求只观察一次", async () => {
  const task = await archiveTaskFixture();
  const provider = await heldModel({
    usage: { promptTokens: 31, completionTokens: 4 },
  });
  const starts: Parameters<typeof observedExtension>[1] = [];
  const ends: string[] = [];
  const external: string[] = [];
  try {
    const model = createInstanceChatModel("observed-model", {
      apiKey: "fixture-key-not-context",
      baseUrl: provider.baseUrl,
      useResponsesApi: false,
      invocationMaxRetries: 0,
    });
    const backend = task.handle.backend;
    const archives = createContextHistoryArchiveBindings();
    const agent = createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model,
      backendResult: {
        factory: () => backend,
        sandboxDir: task.identity.rootDirectory,
        ephemeral: false,
      },
      systemPrompt: "处理真实任务",
      checkpointer: new MemorySaver(),
      runToolContext: { ...task.execution, threadId: "automatic-observation" },
      contextHistoryArchives: archives,
      kernelTools: [
        createReadHistoryTool(
          archives,
          requireContextHistoryPageBudget(task.handle),
        ),
      ],
      runExtensions: [observedExtension("chat-run", starts, ends)],
      autoCompact: resolveCompactionPlan({
        contextWindow: 10000,
        retention: { compactKeepMessages: 4, compactFallbackKeepMessages: 4 },
      }),
      llmRetry: { maxAttempts: 1, infinite: false },
    });
    const pending = consume(
      agent.streamEvents(
        { messages: history() },
        {
          version: "v2",
          configurable: { thread_id: "automatic-observation" },
          callbacks: [
            BaseCallbackHandler.fromMethods({
              handleChatModelStart(_model, _messages, id) {
                external.push(id);
              },
            }),
          ],
        },
      ),
    );
    await Promise.race([provider.firstRequest, pending]);
    provider.finish(0);
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    provider.finish(1);
    await pending;
    expect(starts.map((r) => r.purpose)).toEqual([
      "automatic-compaction",
      "agent",
    ]);
    expect(ends).toEqual(starts.map((r) => r.id));
    expect(external).toEqual(starts.map((r) => r.id));
    for (const [index, row] of starts.entries()) {
      const wire = provider.requests[index]?.body.messages;
      if (!Array.isArray(wire)) throw new Error("模型没有实际HTTP消息");
      expect(row.messages[0]?.map((message) => message.content)).toEqual(
        (wire as { content: unknown }[]).map((message) => message.content),
      );
    }
    expect(starts[0]?.messages[0]).toHaveLength(1);
    expect(starts[1]?.messages[0]?.length).toBeLessThan(20);
  } finally {
    await provider.close();
    await task.cleanup();
  }
}, 60000);

it("手动摘要使用当前维护操作的观察者并保留原checkpoint历史", async () => {
  const task = await archiveTaskFixture();
  const provider = await heldModel({
    usage: { promptTokens: 31, completionTokens: 4 },
  });
  const starts: Parameters<typeof observedExtension>[1] = [];
  const ends: string[] = [];
  const usage: {
    modelCallId: string;
    inputTokens: number;
    outputTokens: number;
  }[] = [];
  const model = createInstanceChatModel("observed-model", {
    apiKey: "fixture-key-not-context",
    baseUrl: provider.baseUrl,
    useResponsesApi: false,
    invocationMaxRetries: 0,
  });
  const backend = task.handle.backend;
  const archives = createContextHistoryArchiveBindings();
  const checkpointer = new MemorySaver();
  const make = (owner: string) =>
    createKenFutWorkDeepAgent({
      env: loadServerEnv({}, {}),
      preset: "code",
      model,
      checkpointer,
      backendResult: {
        factory: () => backend,
        sandboxDir: task.identity.rootDirectory,
        ephemeral: false,
      },
      systemPrompt: "处理真实任务",
      runToolContext: {
        ...task.execution,
        runId: owner,
        threadId: "manual-observation",
      },
      contextHistoryArchives: archives,
      kernelTools: [
        createReadHistoryTool(
          archives,
          requireContextHistoryPageBudget(task.handle),
        ),
      ],
      runExtensions: [observedExtension(owner, starts, ends)],
      manualCompactPlan: {
        trigger: { type: "tokens", value: 1 },
        keep: { type: "messages", value: 4 },
        source: "fraction",
      },
      llmRetry: { maxAttempts: 1, infinite: false },
    });
  try {
    const firstRunId = randomUUID();
    const maintenanceRunId = randomUUID();
    const first = make(firstRunId);
    const pending = consume(
      first.streamEvents(
        { messages: history() },
        { version: "v2", configurable: { thread_id: "manual-observation" } },
      ),
    );
    await Promise.race([provider.firstRequest, pending]);
    provider.finish(0);
    await pending;
    first.releaseContextHistory?.();
    const maintenance = make(maintenanceRunId);
    if (!maintenance.contextHistory) throw new Error("维护操作缺少历史接口");
    const receipt = maintenance.contextHistory.compactCurrent({
      threadId: "manual-observation",
      onUsage: (value) => {
        usage.push(value);
      },
    });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    provider.finish(1);
    expect(await receipt).toMatchObject({ status: "applied" });
    expect(starts.map((r) => ({ owner: r.owner, purpose: r.purpose }))).toEqual(
      [
        { owner: firstRunId, purpose: "agent" },
        { owner: maintenanceRunId, purpose: "manual-compaction" },
      ],
    );
    expect(ends).toEqual(starts.map((r) => r.id));
    expect(usage).toEqual([
      {
        modelCallId: starts[1]?.id,
        inputTokens: 31,
        outputTokens: 4,
      },
    ]);
    const reference =
      await maintenance.contextHistory.captureCurrentReference(
        "manual-observation",
      );
    if (!reference) throw new Error("手动摘要没有持久引用");
    const effective =
      await maintenance.contextHistory.getEffectiveState(reference);
    expect(effective.messages.filter((m) => m.summary)).toHaveLength(1);
  } finally {
    await provider.close();
    await task.cleanup();
  }
}, 60000);
