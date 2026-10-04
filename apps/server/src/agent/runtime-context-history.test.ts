import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamEvent } from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { FilesystemBackend } from "deepagents";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import { createTaskWorkManager } from "../features/task-work/service.js";
import { createMemoryTaskWorkStore } from "../features/task-work/test-store.js";
import type { TaskWorkContext } from "../features/task-work/types.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";
import { createAgentPersistenceService } from "./persistence/index.js";
import { createAgentRunService } from "./runtime.js";

class ControlledModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  constructor() {
    super({});
  }
  _llmType() {
    return "controlled-harness-history";
  }
  bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    return {
      generations: [{ text: "已完成", message: new AIMessage("已完成") }],
    };
  }
}

async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-harness-history-")),
  );
  const scope = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    generation: 1,
    rootDirectory: directory,
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
  };
  const actor = { id: "owner", accessToken: "", email: "", userMetadata: {} };
  const handle = await createExecutionScopes({
    repository: {
      load: async () => ({ state: "ready", branchGeneration: 1, scope }),
    },
    viewerService: {
      resolveWorkspace: async () => ({ id: scope.workspaceId }),
    } as never,
  }).openTask(actor, scope.taskId);
  const context: TaskWorkContext = {
    actor,
    scope,
    agentId: handle.agentId,
    runId: "seed",
    branchGeneration: 1,
  };
  const work = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: directory,
    resolveMaxConcurrent: async () => 4,
  });
  const env = loadServerEnv({
    agentBackendMode: "filesystem",
    agentFilesRoot: directory,
    autoCompactTriggerTokens: 10_000,
  });
  const persistence = createAgentPersistenceService({});
  const model = new ControlledModel();
  const runtime = createAgentRunService({
    blob: {} as never,
    env,
    model,
    agentPersistenceService: persistence,
    taskWork: work,
    resolveTaskWorkContext: async (_actor, current, runId) => ({
      ...context,
      scope: current.describe(),
      runId,
    }),
    resolveCodeApprovalMode: async () => ({
      mode: "build",
      scopeGeneration: 1,
      branchGeneration: 1,
    }),
  });
  const run = async (
    prompt: string,
    sourceCommandId: string,
    clientId = "client-A",
  ) => {
    const created = runtime.createRun(
      {
        sessionId: scope.taskId,
        conversationId: scope.taskId,
        taskId: scope.taskId,
        projectId: scope.projectId,
        preset: "code",
        prompt,
      },
      {
        scopeHandle: handle,
        userId: actor.id,
        threadId: "harness-thread",
        inputIdentity: { clientId, sourceCommandId },
        inputOrigin: "userInput",
      },
    );
    const events: StreamEvent[] = [];
    for await (const event of runtime.streamRun(created.runId))
      events.push(event);
    return { ...created, events };
  };
  return {
    directory,
    env,
    persistence,
    model,
    run,
    close: async () => {
      await work.close("test cleanup");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("真实RunService只报告本轮已提交的新压缩，下一轮重用摘要不重复报告", async () => {
  const f = await fixture();
  try {
    const saved = await f.persistence.getPersistence();
    if (!saved) throw new Error("真实Harness需要MemorySaver");
    const backend = new FilesystemBackend({
      rootDir: f.directory,
      virtualMode: true,
    });
    const seed = createKenFutWorkDeepAgent({
      env: f.env,
      model: f.model,
      preset: "code",
      systemPrompt: "实际历史种子",
      backendResult: {
        factory: () => backend,
        sandboxDir: f.directory,
        ephemeral: false,
      },
      ...saved,
    });
    const history = Array.from({ length: 30 }, (_, index): BaseMessage => {
      const content =
        index < 10 ? `${index}:${"x".repeat(10_000)}` : `短消息 ${index}`;
      return index % 2 ? new AIMessage(content) : new HumanMessage(content);
    });
    for await (const _event of seed.streamEvents(
      { messages: history },
      { version: "v2", configurable: { thread_id: "harness-thread" } },
    )) {
    }
    const first = await f.run("继续工作", "first-input");
    expect(first.events.at(-1)?.type).toBe("run.completed");
    expect(
      first.events.filter((event) => event.type === "run.compacted"),
    ).toHaveLength(1);
    const beforeSecond = f.model.requests.length;
    const second = await f.run("沿用上下文继续", "second-input");
    expect(second.events.at(-1)?.type).toBe("run.completed");
    expect(f.model.requests.slice(beforeSecond)).toHaveLength(1);
    expect(
      f.model.requests
        .at(-1)
        ?.some(
          (message) => message.additional_kwargs.lc_source === "summarization",
        ),
    ).toBe(true);
    expect(
      second.events.filter((event) => event.type === "run.compacted"),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it("同一可信输入重试保留native HumanMessage身份，不同client同command保持独立", async () => {
  const f = await fixture();
  try {
    await f.run("原输入", "same-command");
    const first = f.model.requests
      .at(-1)
      ?.filter(HumanMessage.isInstance)
      .find((message) => message.content === "原输入");
    expect(first?.id).toEqual(expect.any(String));
    await f.run("原输入", "same-command");
    const retried =
      f.model.requests
        .at(-1)
        ?.filter(HumanMessage.isInstance)
        .filter((message) => message.content === "原输入") ?? [];
    expect(retried).toHaveLength(1);
    expect(retried[0]?.id).toBe(first?.id);
    await f.run("另一client输入", "same-command", "client-B");
    const last = f.model.requests.at(-1)?.filter(HumanMessage.isInstance) ?? [];
    expect(last.find((message) => message.content === "原输入")?.id).toBe(
      first?.id,
    );
    expect(
      last.find((message) => message.content === "另一client输入")?.id,
    ).not.toBe(first?.id);
  } finally {
    await f.close();
  }
});
