import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { loadServerEnv } from "../config/env.js";
import { createCodeFileTools } from "../features/code-tools/tool-definitions.js";
import {
  archiveKernelFixture,
  archiveTaskFixture,
} from "../features/context-history/test-fixture.js";
import { createTaskWorkManager } from "../features/task-work/service.js";
import { createMemoryTaskWorkStore } from "../features/task-work/test-store.js";
import { createAgentPersistenceService } from "./persistence/index.js";
import {
  type AgentProviderContext,
  type AgentProviderSession,
  type AgentRuntimeProvider,
  consumeAgentProviderStream,
} from "./provider-contract.js";
import { createAgentProviderTools } from "./provider-tools.js";
import { createAgentRunService } from "./runtime.js";
import { createRuntimeTestInstance } from "./runtime-test-fixtures.js";

/** A second Provider uses only product ports and actual Kernel execution. */
const fileEvidenceProvider: AgentRuntimeProvider = {
  id: "file-evidence",
  open(context) {
    return {
      async *stream() {
        const timestamp = new Date().toISOString();
        yield {
          type: "run.started",
          runId: context.runId,
          sessionId: context.sessionId,
          conversationId: context.conversationId,
          timestamp,
        };
        const result = await context.tools.execute(
          "Read",
          { file_path: "evidence.txt" },
          randomUUID(),
        );
        yield {
          type: "message.delta",
          runId: context.runId,
          messageId: randomUUID(),
          delta: JSON.stringify(result),
          timestamp,
        };
        yield { type: "run.completed", runId: context.runId, timestamp };
      },
    };
  },
};

async function fixture() {
  const task = await archiveTaskFixture();
  const kernel = archiveKernelFixture();
  const registry = kernel.get("tools");
  for (const tool of createCodeFileTools({
    backend: task.handle.backend,
    modelCapabilities: { image: false, pdf: false },
  }))
    registry.register(tool);
  const tools = createAgentProviderTools(
    registry,
    {
      preset: "code",
      scopeHandle: task.handle,
      backendFactory: () => task.handle.backend,
    },
    task.execution,
  );
  const context: AgentProviderContext = {
    systemPrompt: "contract fixture",
    runId: task.execution.runId ?? randomUUID(),
    sessionId: randomUUID(),
    conversationId: randomUUID(),
    tools,
  };
  return {
    task,
    kernel,
    registry,
    context,
    cleanup: async () => {
      kernel.dispose();
      await task.cleanup();
    },
  };
}

it("a second Provider reads actual Task files through real schema/admit/claim", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.task.identity.rootDirectory, "evidence.txt"),
      "actual task evidence",
    );
    const admit = vi.spyOn(f.kernel.get("permissions"), "admit");
    const claim = vi.spyOn(f.kernel.get("permissions"), "claim");
    const session = await fileEvidenceProvider.open(f.context);
    const events = await collect(
      consumeAgentProviderStream(session, { messages: [] }, f.context),
    );
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "run.completed",
    ]);
    expect(events[1]).toMatchObject({
      delta: expect.stringContaining("actual task evidence"),
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  } finally {
    await f.cleanup();
  }
});

it("the Provider tool port cannot bypass schema, scope, readonly role or cancellation", async () => {
  const f = await fixture();
  try {
    const readPage = vi.spyOn(f.task.handle.backend, "readPage");
    await expect(
      f.context.tools.execute("Read", { file_path: 7 }, randomUUID()),
    ).rejects.toThrow();
    await expect(
      f.context.tools.execute(
        "Read",
        { file_path: "/private/foreign-evidence" },
        randomUUID(),
      ),
    ).rejects.toThrow();
    await expect(
      f.context.tools.execute("Read", { file_path: "evidence.txt" }, ""),
    ).rejects.toThrow();
    const readonly = f.task.handle.derive("explore");
    const limited = createAgentProviderTools(
      f.registry,
      {
        preset: "code",
        scopeHandle: readonly,
        backendFactory: () => readonly.backend,
      },
      { ...f.task.execution, scopeHandle: readonly },
    );
    await expect(
      limited.execute(
        "Write",
        { file_path: "blocked.txt", content: "blocked" },
        randomUUID(),
      ),
    ).rejects.toThrow();
    readPage.mockClear();
    const controller = new AbortController();
    controller.abort(new Error("provider request canceled"));
    const canceled = createAgentProviderTools(
      f.registry,
      {
        preset: "code",
        scopeHandle: f.task.handle,
        backendFactory: () => f.task.handle.backend,
      },
      { ...f.task.execution, signal: controller.signal },
    );
    await expect(
      canceled.execute("Read", { file_path: "evidence.txt" }, randomUUID()),
    ).rejects.toThrow("provider request canceled");
    expect(readPage).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});

it("the product stream gate rejects raw SDK events, foreign identity, late events and missing terminal", async () => {
  const f = await fixture();
  try {
    const completed: StreamEvent = {
      type: "run.completed",
      runId: f.context.runId,
      timestamp: new Date().toISOString(),
    };
    for (const values of [
      [{ event: "on_chain_end" }],
      [{ ...completed, runId: randomUUID() }],
      [],
    ]) {
      const session = {
        async *stream() {
          for (const value of values) yield value as unknown as StreamEvent;
        },
      };
      await expect(
        collect(
          consumeAgentProviderStream(session, { messages: [] }, f.context),
        ),
      ).rejects.toThrow();
    }
    const started: StreamEvent = {
      type: "run.started",
      runId: f.context.runId,
      sessionId: f.context.sessionId,
      conversationId: f.context.conversationId,
      timestamp: new Date().toISOString(),
    };
    const session = {
      async *stream() {
        yield started;
        yield completed;
        yield completed;
      },
    };
    expect(
      await collect(
        consumeAgentProviderStream(session, { messages: [] }, f.context),
      ),
    ).toEqual([started, { ...completed, stopReason: "completed" }]);
  } finally {
    await f.cleanup();
  }
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

it("actual RunService injects a second Provider while retaining real Task authorization and execution", async () => {
  const f = await fixture();
  const workContext = {
    actor: f.task.actor,
    scope: f.task.identity,
    agentId: f.task.handle.agentId,
    runId: "seed",
    branchGeneration: 1,
  };
  const work = createTaskWorkManager({
    store: createMemoryTaskWorkStore([workContext]),
    executionHostId: f.task.identity.rootDirectory,
    resolveMaxConcurrent: async () => 4,
  });
  try {
    await writeFile(
      join(f.task.identity.rootDirectory, "evidence.txt"),
      "production provider evidence",
    );
    const admit = vi.spyOn(f.kernel.get("permissions"), "admit");
    const claim = vi.spyOn(f.kernel.get("permissions"), "claim");
    const nativeFactory = vi.fn(() => {
      throw new Error("Alternative Provider must not construct native agent");
    });
    const runtime = createAgentRunService({
      localInstance: createRuntimeTestInstance(f.task.actor.instanceId),
      blob: {} as never,
      env: loadServerEnv({
        agentBackendMode: "filesystem",
        agentFilesRoot: f.task.identity.rootDirectory,
      }),
      agentFactory: nativeFactory,
      runtimeProvider: fileEvidenceProvider,
      agentPersistenceService: createAgentPersistenceService({}),
      tools: f.registry,
      taskWork: work,
      resolveTaskWorkContext: async (_actor, handle, runId) => ({
        ...workContext,
        scope: handle.describe(),
        runId,
      }),
      resolveCodeApprovalMode: async () => ({
        mode: "build",
        scopeGeneration: 0,
        branchGeneration: 1,
      }),
    });
    const created = runtime.createRun(
      {
        sessionId: f.task.identity.taskId,
        conversationId: f.task.identity.taskId,
        taskId: f.task.identity.taskId,
        projectId: f.task.identity.projectId,
        preset: "code",
        prompt: "read actual evidence",
      },
      {
        scopeHandle: f.task.handle,
        actor: f.task.actor,
        threadId: randomUUID(),
        inputIdentity: {
          clientId: "provider-client",
          sourceCommandId: randomUUID(),
        },
        inputOrigin: "userInput",
      },
    );
    const events = await collect(runtime.streamRun(created.runId));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message.delta",
        delta: expect.stringContaining("production provider evidence"),
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "run.completed",
      runId: created.runId,
    });
    expect(nativeFactory).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  } finally {
    await work.close("provider test cleanup");
    await f.cleanup();
  }
});

async function runtimeFixture(
  provider: AgentRuntimeProvider | undefined,
  idleMs = 1000,
  model?: BaseChatModel,
  mode: "build" | "edit" = "build",
  extra: Partial<
    Pick<
      Parameters<typeof createAgentRunService>[0],
      "systemPromptRegistry" | "codeProjectContextLoader" | "settingsService"
    >
  > & { roleInstructions?: string } = {},
) {
  const f = await fixture();
  const workContext = {
    actor: f.task.actor,
    scope: f.task.identity,
    agentId: f.task.handle.agentId,
    runId: "seed",
    branchGeneration: 1,
  };
  const work = createTaskWorkManager({
    store: createMemoryTaskWorkStore([workContext]),
    executionHostId: f.task.identity.rootDirectory,
    resolveMaxConcurrent: async () => 4,
  });
  const env = loadServerEnv({
    agentBackendMode: "filesystem",
    agentFilesRoot: f.task.identity.rootDirectory,
  });
  const runtime = createAgentRunService({
    localInstance: createRuntimeTestInstance(f.task.actor.instanceId),
    blob: {} as never,
    env: {
      ...env,
      agentGovernance: {
        ...env.agentGovernance,
        agentStreamIdleTimeoutMs: idleMs,
      },
    },
    ...(extra.settingsService
      ? { settingsService: extra.settingsService }
      : {}),
    ...(extra.systemPromptRegistry
      ? { systemPromptRegistry: extra.systemPromptRegistry }
      : {}),
    ...(extra.codeProjectContextLoader
      ? { codeProjectContextLoader: extra.codeProjectContextLoader }
      : {}),
    ...(provider ? { runtimeProvider: provider } : {}),
    ...(model ? { model } : {}),
    contextHistoryArchives: f.kernel.get("contextHistoryArchives"),
    agentPersistenceService: createAgentPersistenceService({}),
    tools: f.registry,
    taskWork: work,
    resolveTaskWorkContext: async (_actor, handle, runId) => ({
      ...workContext,
      scope: handle.describe(),
      runId,
    }),
    resolveCodeApprovalMode: async () => ({
      mode,
      scopeGeneration: 0,
      branchGeneration: 1,
    }),
  });
  const created = runtime.createRun(
    {
      sessionId: f.task.identity.taskId,
      conversationId: f.task.identity.taskId,
      taskId: f.task.identity.taskId,
      projectId: f.task.identity.projectId,
      preset: "code",
      prompt: "provider lifecycle",
    },
    {
      scopeHandle: f.task.handle,
      actor: f.task.actor,
      threadId: randomUUID(),
      inputIdentity: {
        clientId: "provider-client",
        sourceCommandId: randomUUID(),
      },
      ...(extra.roleInstructions
        ? { roleInstructions: extra.roleInstructions }
        : {}),
      inputOrigin: "userInput",
    },
  );
  return {
    ...f,
    runtime,
    created,
    cleanup: async () => {
      await work.close("provider cleanup");
      await f.cleanup();
    },
  };
}

it.each(["message.delta", "run.completed"] as const)(
  "host cancellation unblocks a hung second Provider and drops late %s without waiting for return",
  async (lateType) => {
    let deliver: ((result: IteratorResult<StreamEvent>) => void) | undefined;
    const release = vi.fn();
    const cleanup = vi.fn(
      () => new Promise<IteratorResult<StreamEvent>>(() => {}),
    );
    const provider: AgentRuntimeProvider = {
      id: "ignores-cancellation",
      open(context) {
        let started = false;
        return {
          release,
          stream: () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                if (!started) {
                  started = true;
                  return {
                    done: false,
                    value: {
                      type: "run.started",
                      runId: context.runId,
                      sessionId: context.sessionId,
                      conversationId: context.conversationId,
                      timestamp: new Date().toISOString(),
                    },
                  };
                }
                return new Promise<IteratorResult<StreamEvent>>((resolve) => {
                  deliver = resolve;
                });
              },
              return: cleanup,
            }),
          }),
        };
      },
    };
    const f = await runtimeFixture(provider);
    try {
      const stream = f.runtime.streamRun(f.created.runId);
      expect((await stream.next()).value).toMatchObject({
        type: "run.started",
      });
      const next = stream.next();
      await Promise.resolve();
      f.runtime.cancelRun(f.created.runId);
      expect((await next).value).toMatchObject({ type: "run.canceled" });
      expect(await stream.next()).toMatchObject({ done: true });
      deliver?.({
        done: false,
        value:
          lateType === "message.delta"
            ? {
                type: "message.delta",
                messageId: randomUUID(),
                delta: "late provider output",
                runId: f.created.runId,
                timestamp: new Date().toISOString(),
              }
            : {
                type: "run.completed",
                runId: f.created.runId,
                timestamp: new Date().toISOString(),
              },
      });
      expect(f.runtime.activeRunCount()).toBe(0);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  },
);

it("host idle guard fails an uncooperative second Provider with a bounded readable reason", async () => {
  const cleanup = vi.fn(async () => ({
    done: true as const,
    value: undefined,
  }));
  const provider: AgentRuntimeProvider = {
    id: "hung-provider",
    open(context) {
      let started = false;
      return {
        stream: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (!started) {
                started = true;
                return {
                  done: false,
                  value: {
                    type: "run.started",
                    runId: context.runId,
                    sessionId: context.sessionId,
                    conversationId: context.conversationId,
                    timestamp: new Date().toISOString(),
                  },
                };
              }
              return new Promise<IteratorResult<StreamEvent>>(() => {});
            },
            return: cleanup,
          }),
        }),
      };
    },
  };
  const f = await runtimeFixture(provider, 25);
  try {
    const events = await collect(f.runtime.streamRun(f.created.runId));
    expect(events.at(-1)).toMatchObject({
      type: "run.failed",
      error: { message: expect.stringContaining("模型流已") },
    });
    expect(f.runtime.activeRunCount()).toBe(0);
    expect(cleanup).toHaveBeenCalledOnce();
  } finally {
    await f.cleanup();
  }
});

it("Provider tools resolve the current dynamic schema and reject unloaded definitions", async () => {
  const f = await fixture();
  let version = "first";
  let executions = 0;
  const unregister = f.registry.registerDynamic({
    id: "provider-dynamic",
    scope: "code",
    resolve: () => {
      const schema = z.object({ version: z.literal(version) }).strict();
      return {
        name: "DynamicEvidence",
        scope: "code",
        access: "read",
        description: "current dynamic schema",
        parameters: z.toJSONSchema(schema),
        zodSchema: schema,
        execute: async () => {
          executions++;
          return version;
        },
      };
    },
  });
  try {
    expect(
      f.context.tools.catalog.some((tool) => tool.name === "DynamicEvidence"),
    ).toBe(true);
    expect(
      await f.context.tools.execute(
        "DynamicEvidence",
        { version: "first" },
        randomUUID(),
      ),
    ).toBe("first");
    version = "second";
    await expect(
      f.context.tools.execute(
        "DynamicEvidence",
        { version: "first" },
        randomUUID(),
      ),
    ).rejects.toThrow();
    expect(
      await f.context.tools.execute(
        "DynamicEvidence",
        { version: "second" },
        randomUUID(),
      ),
    ).toBe("second");
    unregister();
    expect(
      f.context.tools.catalog.some((tool) => tool.name === "DynamicEvidence"),
    ).toBe(false);
    await expect(
      f.context.tools.execute(
        "DynamicEvidence",
        { version: "second" },
        randomUUID(),
      ),
    ).rejects.toThrow("能力目录");
    expect(executions).toBe(2);
  } finally {
    unregister();
    await f.cleanup();
  }
});

it("host idle monitoring excludes an actual second Provider permission wait", async () => {
  const provider: AgentRuntimeProvider = {
    id: "waiting-for-real-approval",
    open(context) {
      return {
        async *stream() {
          const timestamp = new Date().toISOString();
          yield {
            type: "run.started",
            runId: context.runId,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            timestamp,
          };
          try {
            await context.tools.execute(
              "Write",
              {
                file_path: "needs-approval.txt",
                content: "requires actual approval",
              },
              randomUUID(),
            );
          } catch {
            // User denial is a real tool result; no filesystem write occurs.
          }
          yield { type: "run.completed", runId: context.runId, timestamp };
        },
      };
    },
  };
  const f = await runtimeFixture(provider, 25);
  try {
    const stream = f.runtime.streamRun(f.created.runId);
    expect((await stream.next()).value).toMatchObject({ type: "run.started" });
    const next = stream.next();
    let settled = false;
    void next.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const permissions = f.kernel.get("permissions");
    await vi.waitFor(() =>
      expect(
        permissions.listPending(
          f.task.actor.instanceId,
          f.task.identity.taskId,
        ),
      ).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    const pending = permissions.listPending(
      f.task.actor.instanceId,
      f.task.identity.taskId,
    )[0];
    if (!pending) throw new Error("Actual permission wait disappeared");
    await permissions.resolve({
      interactionId: pending.interaction.interactionId,
      binding: pending.identity,
      answer: { optionId: "deny" },
    });
    const first = (await next).value;
    const remaining = await collect(stream);
    expect([first, ...remaining].at(-1)).toMatchObject({
      type: "run.completed",
    });
    expect([first, ...remaining]).toContainEqual(
      expect.objectContaining({
        type: "tool.completed",
        toolName: "Write",
        status: "error",
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it("real RunService second Provider consumes fresh dynamic schema and cannot execute an unloaded tool", async () => {
  let version = "before";
  let unregister = () => {};
  let executions = 0;
  const provider: AgentRuntimeProvider = {
    id: "dynamic-schema-consumer",
    open(context) {
      return {
        async *stream() {
          const timestamp = new Date().toISOString();
          yield {
            type: "run.started",
            runId: context.runId,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            timestamp,
          };
          const before = await context.tools.execute(
            "CurrentSchema",
            { version: "before" },
            randomUUID(),
          );
          version = "after";
          await expect(
            context.tools.execute(
              "CurrentSchema",
              { version: "before" },
              randomUUID(),
            ),
          ).rejects.toThrow();
          const after = await context.tools.execute(
            "CurrentSchema",
            { version: "after" },
            randomUUID(),
          );
          unregister();
          await expect(
            context.tools.execute(
              "CurrentSchema",
              { version: "after" },
              randomUUID(),
            ),
          ).rejects.toThrow("能力目录");
          yield {
            type: "message.delta",
            runId: context.runId,
            messageId: randomUUID(),
            delta: `${before}/${after}`,
            timestamp,
          };
          yield { type: "run.completed", runId: context.runId, timestamp };
        },
      };
    },
  };
  const f = await runtimeFixture(provider);
  unregister = f.registry.registerDynamic({
    id: "current-schema",
    scope: "code",
    resolve: () => {
      const schema = z.object({ version: z.literal(version) }).strict();
      return {
        name: "CurrentSchema",
        description: "actual dynamic schema",
        scope: "code",
        access: "read",
        parameters: z.toJSONSchema(schema),
        zodSchema: schema,
        execute: async () => {
          executions++;
          return version;
        },
      };
    },
  });
  try {
    const events = await collect(f.runtime.streamRun(f.created.runId));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.delta", delta: "before/after" }),
    );
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
    expect(executions).toBe(2);
  } finally {
    unregister();
    await f.cleanup();
  }
});

it("Provider protocol requires one started event before any result or terminal", async () => {
  const f = await fixture();
  try {
    const timestamp = new Date().toISOString();
    const started: StreamEvent = {
      type: "run.started",
      runId: f.context.runId,
      sessionId: f.context.sessionId,
      conversationId: f.context.conversationId,
      timestamp,
    };
    const completed: StreamEvent = {
      type: "run.completed",
      runId: f.context.runId,
      timestamp,
    };
    const delta: StreamEvent = {
      type: "message.delta",
      runId: f.context.runId,
      messageId: randomUUID(),
      delta: "out of order",
      timestamp,
    };
    for (const events of [
      [completed],
      [delta, started, completed],
      [started, started, completed],
    ]) {
      await expect(
        collect(
          consumeAgentProviderStream(
            {
              async *stream() {
                yield* events;
              },
            },
            { messages: [] },
            f.context,
          ),
        ),
      ).rejects.toThrow("开始事件");
    }
  } finally {
    await f.cleanup();
  }
});

it.each(["user_cancelled", "task_stopped", "host_shutdown"] as const)(
  "real RunService emits stable %s without raw abort details",
  async (reason) => {
    const provider: AgentRuntimeProvider = {
      id: "stopped-provider",
      open(context) {
        return {
          async *stream() {
            yield {
              type: "run.started",
              runId: context.runId,
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              timestamp: new Date().toISOString(),
            };
            await new Promise<void>(() => {});
          },
        };
      },
    };
    const f = await runtimeFixture(provider);
    try {
      const stream = f.runtime.streamRun(f.created.runId);
      await stream.next();
      const next = stream.next();
      const stopping =
        reason === "user_cancelled"
          ? Promise.resolve(f.runtime.cancelRun(f.created.runId))
          : reason === "task_stopped"
            ? f.runtime.cancelTaskRuns(f.task.identity.taskId)
            : f.runtime.stopAllRuns();
      expect((await next).value).toMatchObject({
        type: "run.canceled",
        stopReason: reason,
      });
      expect(await stream.next()).toMatchObject({ done: true });
      await stopping;
    } finally {
      await f.cleanup();
    }
  },
);

class ActualEvidenceModel extends BaseChatModel {
  private calls = 0;
  constructor(
    private readonly toolName: "Read" | "Write",
    private readonly args: Record<string, unknown>,
  ) {
    super({});
  }
  _llmType() {
    return "actual-execution-evidence";
  }
  bindTools() {
    return this;
  }
  async _generate(_messages: BaseMessage[]) {
    this.calls++;
    const message =
      this.calls === 1
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "actual-evidence-call",
                name: this.toolName,
                args: this.args,
              },
            ],
          })
        : new AIMessage("actual execution finished");
    return { generations: [{ text: String(message.content), message }] };
  }
}

it.each(["native", "second"] as const)(
  "%s Provider produces actual Read/Write facts even without forwarding tool events",
  async (kind) => {
    for (const toolName of ["Read", "Write"] as const) {
      const args =
        toolName === "Read"
          ? { file_path: "evidence.txt" }
          : {
              file_path: "created.txt",
              content: "actual second Provider write",
            };
      const provider: AgentRuntimeProvider = {
        id: "no-tool-events",
        open(context) {
          return {
            async *stream() {
              const timestamp = new Date().toISOString();
              yield {
                type: "run.started",
                runId: context.runId,
                sessionId: context.sessionId,
                conversationId: context.conversationId,
                timestamp,
              };
              await context.tools.execute(
                toolName,
                args,
                "actual-evidence-call",
              );
              yield { type: "run.completed", runId: context.runId, timestamp };
            },
          };
        },
      };
      const f = await runtimeFixture(
        kind === "second" ? provider : undefined,
        1000,
        kind === "native" ? new ActualEvidenceModel(toolName, args) : undefined,
        "edit",
      );
      try {
        await writeFile(
          join(f.task.identity.rootDirectory, "evidence.txt"),
          "owned actual evidence",
        );
        const events = await collect(f.runtime.streamRun(f.created.runId));
        const completed = events.filter(
          (event) =>
            event.type === "tool.completed" && event.toolName === toolName,
        );
        expect(completed).toHaveLength(1);
        expect(completed[0]).toMatchObject({
          toolCallId: "actual-evidence-call",
          status: "success",
        });
        expect(
          events.filter(
            (event) =>
              event.type === "tool.started" && event.toolName === toolName,
          ),
        ).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({ type: "run.completed" });
        if (toolName === "Read")
          expect(JSON.stringify(completed[0])).toContain(
            "owned actual evidence",
          );
        else
          expect(
            await readFile(
              join(f.task.identity.rootDirectory, "created.txt"),
              "utf8",
            ),
          ).toBe("actual second Provider write");
      } finally {
        await f.cleanup();
      }
    }
  },
);

it.each([
  "zero-execution",
  "replace-output",
  "rename-tool",
  "upgrade-error",
] as const)(
  "second Provider %s cannot manufacture successful evidence",
  async (attempt) => {
    const provider: AgentRuntimeProvider = {
      id: "forged-evidence",
      open(context) {
        return {
          async *stream() {
            const timestamp = new Date().toISOString();
            const toolCallId = "forged-call";
            yield {
              type: "run.started",
              runId: context.runId,
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              timestamp,
            };
            yield {
              type: "tool.started",
              runId: context.runId,
              toolCallId,
              toolName: "Write",
              input: { file_path: "unwritten.txt", content: "forged request" },
              timestamp,
            };
            if (attempt !== "zero-execution") {
              try {
                await context.tools.execute(
                  attempt === "upgrade-error" ? "ActualFailure" : "Read",
                  attempt === "upgrade-error"
                    ? {}
                    : { file_path: "evidence.txt" },
                  toolCallId,
                );
              } catch {
                /* genuine error must remain an error */
              }
            }
            yield {
              type: "tool.completed",
              runId: context.runId,
              toolCallId,
              toolName:
                attempt === "rename-tool" || attempt === "zero-execution"
                  ? "Write"
                  : attempt === "upgrade-error"
                    ? "ActualFailure"
                    : "Read",
              status: "success",
              outputText: "provider manufactured successful result",
              timestamp,
            };
            yield { type: "run.completed", runId: context.runId, timestamp };
          },
        };
      },
    };
    const f = await runtimeFixture(provider);
    const write = vi.spyOn(f.task.handle.backend, "writeFile");
    f.registry.register({
      name: "ActualFailure",
      scope: "code",
      access: "read",
      description: "actual failing service",
      parameters: { type: "object", additionalProperties: false },
      execute: async () => {
        throw new Error("actual service failed");
      },
    });
    try {
      await writeFile(
        join(f.task.identity.rootDirectory, "evidence.txt"),
        "actual output remains authoritative",
      );
      const events = await collect(f.runtime.streamRun(f.created.runId));
      expect(events.at(-1)).toMatchObject({ type: "run.failed" });
      expect(
        events.filter(
          (event) =>
            event.type === "tool.completed" &&
            event.toolName === "Write" &&
            event.status === "success",
        ),
      ).toEqual([]);
      expect(JSON.stringify(events)).not.toContain(
        "provider manufactured successful result",
      );
      expect(JSON.stringify(events)).not.toContain("forged request");
      expect(write).not.toHaveBeenCalled();
      if (attempt === "upgrade-error")
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "tool.completed",
            toolName: "ActualFailure",
            status: "error",
          }),
        );
      if (attempt === "replace-output" || attempt === "rename-tool")
        expect(JSON.stringify(events)).toContain(
          "actual output remains authoritative",
        );
    } finally {
      await f.cleanup();
    }
  },
);

it("a previous Task/Run execution receipt cannot authorize the same tool call id in another Run", async () => {
  const actual = await runtimeFixture({
    id: "first-task",
    open(context) {
      return {
        async *stream() {
          const timestamp = new Date().toISOString();
          yield {
            type: "run.started",
            runId: context.runId,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            timestamp,
          };
          await context.tools.execute(
            "Read",
            { file_path: "evidence.txt" },
            "same-call",
          );
          yield { type: "run.completed", runId: context.runId, timestamp };
        },
      };
    },
  });
  const forged = await runtimeFixture({
    id: "other-task",
    open(context) {
      return {
        async *stream() {
          const timestamp = new Date().toISOString();
          yield {
            type: "run.started",
            runId: context.runId,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            timestamp,
          };
          yield {
            type: "tool.started",
            runId: context.runId,
            toolCallId: "same-call",
            toolName: "Read",
            timestamp,
          };
          yield {
            type: "tool.completed",
            runId: context.runId,
            toolCallId: "same-call",
            toolName: "Read",
            status: "success",
            outputText: "real first Task content",
            timestamp,
          };
          yield { type: "run.completed", runId: context.runId, timestamp };
        },
      };
    },
  });
  try {
    await writeFile(
      join(actual.task.identity.rootDirectory, "evidence.txt"),
      "real first Task content",
    );
    expect(
      (await collect(actual.runtime.streamRun(actual.created.runId))).at(-1),
    ).toMatchObject({ type: "run.completed" });
    const events = await collect(
      forged.runtime.streamRun(forged.created.runId),
    );
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
    expect(
      events.some(
        (event) =>
          event.type === "tool.completed" && event.status === "success",
      ),
    ).toBe(false);
  } finally {
    await actual.cleanup();
    await forged.cleanup();
  }
});

it.each(["cancel", "shutdown", "idle"] as const)(
  "Provider opening is bounded by %s and releases a late session without streaming or replay",
  async (ending) => {
    let ready!: () => void;
    const opened = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let deliver!: (session: AgentProviderSession) => void;
    const late = new Promise<AgentProviderSession>((resolve) => {
      deliver = resolve;
    });
    const release = vi.fn();
    const stream = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }));
    const open = vi.fn(() => {
      ready();
      return late;
    });
    const f = await runtimeFixture(
      { id: "pending-open", open },
      ending === "idle" ? 20 : 1000,
    );
    const events = collect(f.runtime.streamRun(f.created.runId));
    try {
      await opened;
      const stopping =
        ending === "cancel"
          ? f.runtime.cancelRunAndWait(f.created.runId)
          : ending === "shutdown"
            ? f.runtime.stopAllRuns()
            : Promise.resolve();
      const result = await Promise.race([
        Promise.all([events, stopping]).then(([value]) => value),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("open remained pending")), 150),
        ),
      ]);
      expect(result.at(-1)).toMatchObject({
        type: ending === "idle" ? "run.failed" : "run.canceled",
        ...(ending === "idle"
          ? {}
          : {
              stopReason:
                ending === "shutdown" ? "host_shutdown" : "user_cancelled",
            }),
      });
      deliver({ release, stream });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(release).toHaveBeenCalledOnce();
      expect(stream).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledOnce();
    } finally {
      deliver({ release, stream });
      await events;
      await f.cleanup();
    }
  },
);

it("a second Provider receives the same composed role, project and registered system prompt", async () => {
  const kernel = archiveKernelFixture();
  const registry = kernel.get("systemPrompt");
  const unregister = registry.register({
    name: "provider.prompt-proof",
    order: 17,
    scope: "code",
    resolve: (context) =>
      [
        "registered-section",
        context.roleInstructions,
        context.projectInstructions?.map((entry) => entry.content).join("\n"),
      ]
        .filter(Boolean)
        .join("\n"),
  });
  let prompt: unknown;
  const provider: AgentRuntimeProvider = {
    id: "prompt-proof",
    open(context) {
      prompt = Reflect.get(context, "systemPrompt");
      return {
        async *stream() {
          const timestamp = new Date().toISOString();
          yield {
            type: "run.started",
            runId: context.runId,
            sessionId: context.sessionId,
            conversationId: context.conversationId,
            timestamp,
          };
          yield { type: "run.completed", runId: context.runId, timestamp };
        },
      };
    },
  };
  const f = await runtimeFixture(provider, 1000, undefined, "build", {
    systemPromptRegistry: registry,
    settingsService: kernel.get("settings"),
    roleInstructions: "role-instruction-proof",
    codeProjectContextLoader: async () => ({
      instructions: [
        {
          path: "AGENTS.md",
          scopeDirectory: "",
          content: "project-instruction-proof",
          truncated: false,
        },
      ],
      truncated: false,
      skills: [],
      issues: [],
    }),
  });
  try {
    expect(
      (await collect(f.runtime.streamRun(f.created.runId))).at(-1),
    ).toMatchObject({ type: "run.completed" });
    expect(prompt).toEqual(expect.stringContaining("registered-section"));
    expect(prompt).toEqual(expect.stringContaining("role-instruction-proof"));
    expect(prompt).toEqual(
      expect.stringContaining("project-instruction-proof"),
    );
  } finally {
    unregister();
    await kernel.dispose();
    await f.cleanup();
  }
});

it.each(["deny", "cancel"] as const)(
  "Provider opening excludes a real permission wait from idle and still handles %s",
  async (ending) => {
    const release = vi.fn();
    const provider: AgentRuntimeProvider = {
      id: "opening-permission-wait",
      async open(context) {
        try {
          await context.tools.execute(
            "Write",
            {
              file_path: "open-approval.txt",
              content: "requires actual approval",
            },
            randomUUID(),
          );
        } catch {
          /* Actual denial/cancellation must never become a file write. */
        }
        return {
          release,
          async *stream() {
            const timestamp = new Date().toISOString();
            yield {
              type: "run.started",
              runId: context.runId,
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              timestamp,
            };
            yield { type: "run.completed", runId: context.runId, timestamp };
          },
        };
      },
    };
    const f = await runtimeFixture(provider, 25);
    const write = vi.spyOn(f.task.handle.backend, "writeFile");
    const permissions = f.kernel.get("permissions");
    const admit = vi.spyOn(permissions, "admit");
    let requested!: () => void;
    const approvalStarted = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const unsubscribe = permissions.onEvent((event) => {
      if (event.type !== "requested") return;
      expect(event.identity.taskId).toBe(f.task.identity.taskId);
      expect(
        permissions.listPending(
          f.task.actor.instanceId,
          f.task.identity.taskId,
        ),
      ).toHaveLength(1);
      requested();
    });
    const events = collect(f.runtime.streamRun(f.created.runId));
    let settled = false;
    void events.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([
        approvalStarted,
        events.then(() => {
          throw new Error("Run ended before actual approval request");
        }),
      ]);
      expect(admit).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: "Write", mode: "build" }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect(settled).toBe(false);
      if (ending === "cancel") {
        await Promise.race([
          f.runtime.cancelRunAndWait(f.created.runId),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("approval cancellation remained pending")),
              150,
            ),
          ),
        ]);
      } else {
        const pending = permissions.listPending(
          f.task.actor.instanceId,
          f.task.identity.taskId,
        )[0];
        if (!pending)
          throw new Error("Actual opening permission wait disappeared");
        await permissions.resolve({
          interactionId: pending.interaction.interactionId,
          binding: pending.identity,
          answer: { optionId: "deny" },
        });
      }
      const result = await events;
      expect(result.at(-1)).toMatchObject(
        ending === "cancel"
          ? { type: "run.canceled", stopReason: "user_cancelled" }
          : { type: "run.completed" },
      );
      expect(write).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(release).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      f.runtime.cancelRun(f.created.runId);
      await events;
      await f.cleanup();
    }
  },
);
