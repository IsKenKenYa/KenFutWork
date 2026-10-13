import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  type CodeExecutionScope,
} from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { createDeepAgent, StateBackend } from "deepagents";
import type { AgentMiddleware } from "langchain";
import { countTokensApproximately } from "langchain";
import { expect, it, vi } from "vitest";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import {
  createNativeCheckpointArchive,
  nativeArchiveCheckpointConfig,
  referenceFromNativeArchiveUri,
} from "./native-checkpoint-archive.js";
import { effectiveNativeMessages } from "./native-context-history.js";
import { encodeNativeContextReference } from "./native-context-reference.js";
import { createNativeManualCompaction } from "./native-manual-compaction.js";
import { createNativeRecoveryMiddleware } from "./native-recovery-middleware.js";

class SummaryModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  summaryText = "recovery";
  _llmType() {
    return "scoped-archive-regression";
  }
  bindTools() {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    return {
      generations: [
        { text: this.summaryText, message: new AIMessage(this.summaryText) },
      ],
    };
  }
}

it("real SDK offload outside actual Task scope fails before continuation or checkpoint commit", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-archive-scope-")),
  );
  try {
    const identity: CodeExecutionScope = {
      instanceId: randomUUID(),
      projectId: randomUUID(),
      taskId: randomUUID(),
      generation: 0,
      rootDirectory: root,
      additionalDirectories: [],
      sandboxMode: "workspace-write",
    };
    const scopes = createExecutionScopes({
      repository: {
        load: async () => ({
          preset: "code",
          scope: identity,
          state: "ready",
          branchGeneration: 1,
        }),
      },
      localInstance: {
        resolve: async () => ({
          instanceId: identity.instanceId,
          dataDir: root,
        }),
      },
      resolveFileLimits: async () => AGENT_GOVERNANCE_DEFAULTS,
    });
    const handle = await scopes.openTask(
      { instanceId: identity.instanceId, accessClientId: null },
      identity.taskId,
    );
    const middleware = createNativeRecoveryMiddleware({
      backend: () => handle.backend,
      trigger: { type: "messages", value: 0 },
      keep: { type: "messages", value: 1 },
    });
    const hook = middleware.wrapModelCall;
    if (!hook) throw new Error("missing native hook");
    const messages = [
      new HumanMessage("objective"),
      new AIMessage("pending"),
      new HumanMessage("continue"),
    ];
    const request = {
      model: new SummaryModel({}),
      messages,
      state: { messages },
      systemMessage: new SystemMessage(""),
      systemPrompt: "",
      tools: [],
      runtime: { context: {}, configurable: { thread_id: identity.taskId } },
    } as Parameters<NonNullable<AgentMiddleware["wrapModelCall"]>>[0];
    const continuation = vi.fn(async () => new AIMessage("must not continue"));
    await expect(hook(request, continuation)).rejects.toThrow("历史归档失败");
    expect(continuation).not.toHaveBeenCalled();
    expect(request.state).not.toHaveProperty("_summarizationEvent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("real Graph model input binds its already committed checkpoint and successful summary exposes exact readonly history", async () => {
  const threadId = randomUUID();
  let agent: ReturnType<typeof createDeepAgent>;
  let revoked = false;
  const authorized: string[] = [];
  const archive = createNativeCheckpointArchive(
    () => agent,
    async (_reference, owner) => {
      if (owner !== threadId || revoked)
        throw new Error("archive_scope_denied");
      authorized.push(owner);
    },
  );
  const middleware = createNativeRecoveryMiddleware({
    backend: new StateBackend(),
    archive,
    trigger: { type: "messages", value: 1 },
    keep: { type: "messages", value: 1 },
  });
  agent = createDeepAgent({
    model: new SummaryModel({}),
    checkpointer: new MemorySaver(),
    middleware: [middleware],
  });
  const original = "objective 中文😀".repeat(2_000);
  await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [new HumanMessage(original), new AIMessage("unfinished work")],
    },
    "__start__",
  );
  await agent.invoke(
    { messages: [new HumanMessage("continue")] },
    { configurable: { thread_id: threadId } },
  );
  const snapshot = await agent.graph.getState({
    configurable: { thread_id: threadId },
  });
  const event = snapshot.values._summarizationEvent as {
    filePath: string;
    summaryMessage: HumanMessage;
  };
  expect(event.filePath).toMatch(/^kfw-context-history:/);
  expect(event.summaryMessage.content).toContain(event.filePath);
  const reference = referenceFromNativeArchiveUri(event.filePath);
  let offset = 0;
  let text = "";
  for (;;) {
    const page = await archive.read({ reference, offset, limit: 1024 });
    text += page.text;
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  expect(text).toContain(original);
  expect(text).toContain("unfinished work");
  expect(text).toContain("continue");
  expect(authorized.length).toBeGreaterThan(2);
  revoked = true;
  await expect(archive.read({ reference })).rejects.toThrow(
    "archive_scope_denied",
  );
});

it("checkpoint binding rejects pending text and forged cross-Task references", async () => {
  const threadId = randomUUID();
  const agent = createDeepAgent({
    model: new SummaryModel({}),
    checkpointer: new MemorySaver(),
  });
  const saved = await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages: [new HumanMessage("durable")] },
    "__start__",
  );
  const snapshot = await agent.graph.getState(saved);
  const archive = createNativeCheckpointArchive(
    () => agent,
    async (_reference, owner) => {
      if (owner !== threadId) throw new Error("archive_scope_denied");
    },
  );
  await expect(
    archive.bind({ config: saved, messages: [new HumanMessage("pending")] }),
  ).rejects.toThrow("原文与checkpoint不一致");
  const binding = await archive.bind({
    config: saved,
    messages: snapshot.values.messages as BaseMessage[],
  });
  const foreign = {
    ...binding.reference,
    key: JSON.stringify({
      threadId: randomUUID(),
      namespace: "",
      checkpointId: "forged",
    }),
  };
  await expect(archive.read({ reference: foreign })).rejects.toThrow(
    "archive_scope_denied",
  );
});

it("revocation after exact binding blocks the SDK summary model and continuation", async () => {
  const threadId = randomUUID();
  const model = new SummaryModel({});
  const agent = createDeepAgent({ model, checkpointer: new MemorySaver() });
  const saved = await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage("objective"),
        new AIMessage("unfinished"),
        new HumanMessage("next"),
      ],
    },
    "__start__",
  );
  const snapshot = await agent.graph.getState(saved);
  let revoked = false;
  const source = createNativeCheckpointArchive(
    () => agent,
    async () => {
      if (revoked) throw new Error("scope_revoked");
    },
  );
  const archive = {
    ...source,
    async bind(input: Parameters<typeof source.bind>[0]) {
      const binding = await source.bind(input);
      revoked = true;
      return binding;
    },
  };
  const middleware = createNativeRecoveryMiddleware({
    backend: new StateBackend(),
    archive,
    archiveConfig: () => saved,
    trigger: { type: "messages", value: 0 },
    keep: { type: "messages", value: 1 },
  });
  const hook = middleware.wrapModelCall;
  if (!hook) throw new Error("missing native hook");
  const request = {
    model,
    messages: snapshot.values.messages,
    state: snapshot.values,
    systemMessage: new SystemMessage(""),
    systemPrompt: "",
    tools: [],
    runtime: { context: {} },
  } as Parameters<NonNullable<AgentMiddleware["wrapModelCall"]>>[0];
  const continuation = vi.fn(async () => new AIMessage("must not continue"));
  await expect(hook(request, continuation)).rejects.toThrow("scope_revoked");
  expect(model.requests).toHaveLength(0);
  expect(continuation).not.toHaveBeenCalled();
});

it("native node config selects only its pinned parent checkpoint, never the latest state", () => {
  expect(
    nativeArchiveCheckpointConfig({
      configurable: {
        thread_id: "task",
        checkpoint_ns: "model:node",
        checkpoint_map: { "": "exact-root" },
      },
    }),
  ).toEqual({
    configurable: {
      thread_id: "task",
      checkpoint_ns: "",
      checkpoint_id: "exact-root",
    },
  });
  expect(
    nativeArchiveCheckpointConfig({
      configurable: {
        thread_id: "task",
        checkpoint_ns: "child:graph|model:node",
        checkpoint_map: { "": "root", "child:graph": "exact-child" },
      },
    }),
  ).toEqual({
    configurable: {
      thread_id: "task",
      checkpoint_ns: "child:graph",
      checkpoint_id: "exact-child",
    },
  });
  expect(() =>
    nativeArchiveCheckpointConfig({
      configurable: { thread_id: "task", checkpoint_ns: "model:node" },
    }),
  ).toThrow("精确checkpoint");
});

it("manual operation commits the same native readonly archive and recovery semantics", async () => {
  const threadId = randomUUID();
  const model = new SummaryModel({});
  const agent = createDeepAgent({
    model,
    name: "manual-custom-name",
    checkpointer: new MemorySaver(),
  });
  await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage(`objective ${"o".repeat(4_000)}`),
        new AIMessage(`unfinished work ${"w".repeat(4_000)}`),
        new HumanMessage("continue"),
      ],
    },
    "__start__",
  );
  const archive = createNativeCheckpointArchive(
    () => agent,
    async (_reference, owner) => {
      if (owner !== threadId) throw new Error("archive_scope_denied");
    },
  );
  const compact = createNativeManualCompaction({
    agent,
    archive,
    model,
    backend: () => new StateBackend(),
    plan: {
      trigger: { type: "tokens", value: 4_000 },
      keep: { type: "messages", value: 1 },
      source: "fallback",
    },
    llmRetry: { maxAttempts: 1, infinite: false },
  });
  const before = await agent.graph.getState({
    configurable: { thread_id: threadId },
  });
  const beforeMessages = before.values.messages as BaseMessage[];
  const beforeEstimate = countTokensApproximately(beforeMessages);
  const result = await compact({ threadId });
  expect(result.status).toBe("applied");
  const snapshot = await agent.graph.getState({
    configurable: { thread_id: threadId },
  });
  const effective = effectiveNativeMessages(
    snapshot.values.messages as BaseMessage[],
    snapshot.values,
  );
  expect(countTokensApproximately(effective)).toBeLessThan(beforeEstimate);
  const event = snapshot.values._summarizationEvent as { filePath: string };
  const page = await archive.read({
    reference: referenceFromNativeArchiveUri(event.filePath),
  });
  expect(page.text).toContain("unfinished work");
  expect(model.requests).toHaveLength(1);
  const summaryRequest = model.requests[0]?.[0];
  if (!summaryRequest) throw new Error("实际摘要请求缺失");
  expect(summaryRequest.content).toContain(
    "actual persistent Task on every turn",
  );
  expect(summaryRequest.content).toContain("Evidence and gaps");
});

it("manual compaction refuses a summary whose product estimate grows and leaves the checkpoint untouched", async () => {
  const threadId = randomUUID();
  const model = new SummaryModel({});
  const messages = [
    new HumanMessage(`old objective ${"o".repeat(4_000)}`),
    new AIMessage(`old work ${"w".repeat(4_000)}`),
    new HumanMessage("preserved tail"),
  ];
  const agent = createDeepAgent({ model, checkpointer: new MemorySaver() });
  const saved = await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    { messages },
    "__start__",
  );
  const before = await agent.graph.getState(saved);
  const beforeMessages = before.values.messages as BaseMessage[];
  const beforeEstimate = countTokensApproximately(beforeMessages);
  model.summaryText = "expanded summary ".repeat(beforeEstimate * 4);
  expect(
    countTokensApproximately([new HumanMessage(model.summaryText)]),
  ).toBeGreaterThan(beforeEstimate);
  const archive = createNativeCheckpointArchive(
    () => agent,
    async () => {},
  );
  const compact = createNativeManualCompaction({
    agent,
    archive,
    model,
    backend: () => new StateBackend(),
    plan: {
      trigger: { type: "tokens", value: 4_000 },
      keep: { type: "messages", value: 1 },
      source: "fallback",
    },
    llmRetry: { maxAttempts: 1, infinite: false },
  });

  const result = await compact({ threadId });
  expect(result).toMatchObject({
    status: "unchanged",
    reason: "not_reduced",
    reference: encodeNativeContextReference(threadId, before.config),
  });
  const after = await agent.graph.getState({
    configurable: { thread_id: threadId },
  });
  expect(after.config.configurable?.checkpoint_id).toBe(
    before.config.configurable?.checkpoint_id,
  );
  expect(after.values.messages).toEqual(before.values.messages);
  expect(after.values._summarizationEvent).toBeUndefined();
  expect(
    effectiveNativeMessages(
      after.values.messages as BaseMessage[],
      after.values,
    ),
  ).toEqual(beforeMessages);
});

it("manual compaction refuses an equal projection and preserves the previous summary and archive", async () => {
  const threadId = randomUUID();
  const model = new SummaryModel({});
  const agent = createDeepAgent({ model, checkpointer: new MemorySaver() });
  await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage(`objective ${"o".repeat(4_000)}`),
        new AIMessage(`unfinished work ${"w".repeat(4_000)}`),
        new HumanMessage("continue"),
      ],
    },
    "__start__",
  );
  const archive = createNativeCheckpointArchive(
    () => agent,
    async () => {},
  );
  const compact = createNativeManualCompaction({
    agent,
    archive,
    model,
    backend: () => new StateBackend(),
    plan: {
      trigger: { type: "tokens", value: 4_000 },
      keep: { type: "messages", value: 1 },
      source: "fallback",
    },
    llmRetry: { maxAttempts: 1, infinite: false },
  });

  const first = await compact({ threadId });
  expect(first.status).toBe("applied");
  const prior = await agent.graph.getState({
    configurable: { thread_id: threadId },
  });
  const priorEvent = prior.values._summarizationEvent as {
    cutoffIndex: number;
    filePath: string;
    summaryMessage: HumanMessage;
  };
  const priorEffective = effectiveNativeMessages(
    prior.values.messages as BaseMessage[],
    prior.values,
  );
  const priorEstimate = countTokensApproximately(priorEffective);
  expect(priorEvent.filePath).toMatch(/^kfw-context-history:\//u);
  // Same thread, keep target, summary text and fixed-width checkpoint URI yield an equal-sized projection.
  const second = await compact({ threadId });
  expect(second).toMatchObject({
    status: "unchanged",
    reason: "not_reduced",
    reference: encodeNativeContextReference(threadId, prior.config),
  });
  const after = await agent.graph.getState({
    configurable: { thread_id: threadId },
  });
  expect(after.config.configurable?.checkpoint_id).toBe(
    prior.config.configurable?.checkpoint_id,
  );
  expect(after.values.messages).toEqual(prior.values.messages);
  expect(after.values._summarizationEvent).toEqual(priorEvent);
  const afterEffective = effectiveNativeMessages(
    after.values.messages as BaseMessage[],
    after.values,
  );
  expect(countTokensApproximately(afterEffective)).toBe(priorEstimate);
  expect(afterEffective).toEqual(priorEffective);
  const page = await archive.read({
    reference: referenceFromNativeArchiveUri(priorEvent.filePath),
  });
  expect(page.text).toContain("unfinished work");
});

it("revocation while the SDK summary model is running blocks continuation and compaction commit", async () => {
  const threadId = randomUUID();
  let revoked = false;
  class RevokingSummaryModel extends SummaryModel {
    async _generate(messages: BaseMessage[]) {
      const result = await super._generate(messages);
      revoked = true;
      return result;
    }
  }
  const model = new RevokingSummaryModel({});
  const agent = createDeepAgent({ model, checkpointer: new MemorySaver() });
  const saved = await agent.graph.updateState(
    { configurable: { thread_id: threadId } },
    {
      messages: [
        new HumanMessage("objective"),
        new AIMessage("unfinished"),
        new HumanMessage("next"),
      ],
    },
    "__start__",
  );
  const archive = createNativeCheckpointArchive(
    () => agent,
    async () => {
      if (revoked) throw new Error("scope_revoked_during_summary");
    },
  );
  const compact = createNativeManualCompaction({
    agent,
    archive,
    model,
    backend: () => new StateBackend(),
    plan: {
      trigger: { type: "tokens", value: 4_000 },
      keep: { type: "messages", value: 1 },
      source: "fallback",
    },
    llmRetry: { maxAttempts: 1, infinite: false },
  });
  await expect(compact({ threadId })).rejects.toThrow(
    "scope_revoked_during_summary",
  );
  expect(model.requests).toHaveLength(1);
  const snapshot = await agent.graph.getState(saved);
  expect(snapshot.values._summarizationEvent).toBeUndefined();
  expect(
    (await agent.graph.getState({ configurable: { thread_id: threadId } }))
      .config.configurable?.checkpoint_id,
  ).toBe(saved.configurable?.checkpoint_id);
});
