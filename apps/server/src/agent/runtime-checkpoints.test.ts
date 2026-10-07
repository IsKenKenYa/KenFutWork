import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceSettingsSchema, type StreamEvent } from "@kenfutwork/shared";
import type { HumanMessage } from "@langchain/core/messages";
import { afterEach, expect, it } from "vitest";
import type { ServerEnv } from "../config/env.js";
import { codeRolePromptSection } from "../features/agent-runs/prompt-sections.js";
import type { TrustedCodeInput } from "../features/code-ui/attachments/input-types.js";
import type { ExecutionRole } from "../features/execution/scope-service.js";
import { createExecutionScopes } from "../features/execution/scope-service.js";
import { createTaskWorkManager } from "../features/task-work/service.js";
import { createMemoryTaskWorkStore } from "../features/task-work/test-store.js";
import type { TaskWorkContext } from "../features/task-work/types.js";
import { SystemPromptRegistryImpl } from "../kernel/context.js";
import type { KenFutWorkAgentFactory } from "./deep-agent.js";
import { createAgentRunService } from "./runtime.js";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "./runtime-test-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    role?: ExecutionRole;
    failFactory?: boolean;
    failHook?: boolean;
    hang?: boolean;
    failSink?: boolean;
    codeInputs?: TrustedCodeInput[];
    vision?: boolean;
    pdf?: boolean;
  } = {},
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-runtime-task-")),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const scope = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    taskId: "00000000-0000-4000-8000-000000000003",
    generation: 1,
    rootDirectory: directory,
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
  };
  const actor = RUNTIME_TEST_ACTOR;
  const handle = await createExecutionScopes({
    repository: {
      load: async () => ({ state: "ready", branchGeneration: 1, scope }),
    },
    localInstance: createRuntimeTestInstance(),
  }).openTask(actor, scope.taskId);
  const execution = options.role
    ? handle.derive(options.role, "child")
    : handle;
  const context: TaskWorkContext = {
    actor,
    scope,
    agentId: execution.agentId,
    runId: "run",
    branchGeneration: 1,
  };
  const work = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: directory,
    resolveMaxConcurrent: async () => 4,
  });
  cleanups.push(() => work.close("test cleanup"));
  const calls: Array<{
    hook: string;
    taskId: string;
    root: string;
    role: ExecutionRole;
  }> = [];
  const prompts: string[] = [];
  const signals: AbortSignal[] = [];
  const messages: HumanMessage[] = [];
  const registry = new SystemPromptRegistryImpl();
  registry.register(codeRolePromptSection);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const factory = ((input) => {
    prompts.push(input.systemPrompt ?? "");
    if (input.runToolContext?.signal) signals.push(input.runToolContext.signal);
    if (options.failFactory) throw new Error("factory failed");
    return {
      async *streamEvents(_input: unknown, config?: { signal?: AbortSignal }) {
        messages.push(...(_input as { messages: HumanMessage[] }).messages);
        ready();
        if (options.hang)
          await new Promise<void>((resolve) => {
            if (config?.signal?.aborted) resolve();
            else
              config?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
      },
    };
  }) as KenFutWorkAgentFactory;
  const hook = async (
    name: string,
    input: Parameters<
      NonNullable<
        Parameters<typeof createAgentRunService>[0]["checkpointHooks"]
      >["beforeTurn"]
    >[0],
  ) => {
    calls.push({
      hook: name,
      taskId: input.scope.describe().taskId,
      root: input.scope.describe().rootDirectory,
      role: input.scope.role,
    });
    if (options.failHook) throw new Error("checkpoint failed");
  };
  const runtime = createAgentRunService({
    agentFactory: factory,
    blob: {} as never,
    env: {
      agentBackendMode: "state",
      agentModel: "test",
      version: "test",
      port: 0,
      webOrigin: "http://localhost",
      checkpointRoot: directory,
    } as ServerEnv,
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
    model: `${scope.projectId}:model`,
    modelProviders: {
      resolveCredentials: async () => ({
        apiKey: "fixture",
        protocol: "openai-compatible",
        models: [
          {
            id: "model",
            vision: options.vision ?? false,
            inputModalities: options.pdf ? ["text", "pdf"] : ["text"],
          },
        ],
      }),
    } as never,
    localInstance: createRuntimeTestInstance(),
    settingsService: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({
          defaultModel: `${scope.projectId}:model`,
        }),
    },
    systemPromptRegistry: registry,
    checkpointHooks: {
      beforeTurn: (input) => hook("before", input),
      afterTurn: (input) => hook("after", input),
    },
  });
  const created = runtime.createRun(
    {
      sessionId: options.role ? "child" : scope.taskId,
      conversationId: scope.taskId,
      taskId: scope.taskId,
      projectId: scope.projectId,
      preset: "code",
      prompt: "work",
    },
    {
      scopeHandle: execution,
      actor,
      model: `${scope.projectId}:model`,
      ...(options.codeInputs ? { codeInputs: options.codeInputs } : {}),
      ...(options.role ? { roleInstructions: "readonly evidence" } : {}),
      ...(options.failSink
        ? {
            eventSink: async () => {
              throw new Error("event persistence failed");
            },
          }
        : {}),
    },
  );
  const events: StreamEvent[] = [];
  const drain = async () => {
    for await (const event of runtime.streamRun(created.runId))
      events.push(event);
    return events;
  };
  return {
    runtime,
    created,
    calls,
    scope,
    events,
    prompts,
    signals,
    started,
    drain,
    messages,
  };
}

it("Code已授权文本附件确实进入模型消息，创建Run后修改调用端bytes不能改写输入", async () => {
  const bytes = new Uint8Array(Buffer.from("姓名,金额\n小明,12\n"));
  const f = await fixture({
    codeInputs: [
      {
        attachment: {
          ref: "code-attachment:committed",
          fileName: "数据.csv",
          mime: "text/csv",
          bytes: bytes.length,
        },
        bytes,
      },
    ],
  });
  bytes.fill(0);
  expect((await f.drain()).at(-1)?.type).toBe("run.completed");
  expect(f.messages[0]?.content).toEqual([
    { type: "text", text: expect.stringContaining("work") },
    { type: "text", text: expect.stringContaining("姓名,金额\n小明,12\n") },
  ]);
});

it("Code图片附件进入真实多模态消息；所选模型明确不支持图片时可读失败", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    "base64",
  );
  const codeInputs = [
    {
      attachment: {
        ref: "code-attachment:committed-image",
        fileName: "像素.png",
        mime: "image/png",
        bytes: bytes.length,
      },
      bytes,
    },
  ];
  const supported = await fixture({ codeInputs, vision: true });
  expect((await supported.drain()).at(-1)?.type).toBe("run.completed");
  expect(supported.messages[0]?.content).toEqual([
    { type: "text", text: expect.stringContaining("work") },
    {
      type: "image_url",
      image_url: `data:image/png;base64,${bytes.toString("base64")}`,
    },
  ]);
  const unsupported = await fixture({ codeInputs, vision: false });
  expect((await unsupported.drain()).at(-1)).toMatchObject({
    type: "run.failed",
    error: { message: expect.stringContaining("不支持图片") },
  });
  expect(unsupported.messages).toEqual([]);
});

it("Code PDF输入按所选模型走原生文件或真实文本提取，不用PDF声明伪装图片", async () => {
  const bytes = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length 40 >> stream
BT /F1 12 Tf 30 50 Td (Hello PDF) Tj ET
endstream endobj
trailer << /Size 6 /Root 1 0 R >>
%%EOF
`);
  const codeInputs = [
    {
      attachment: {
        ref: "code-attachment:committed-pdf",
        fileName: "文档.pdf",
        mime: "application/pdf",
        bytes: bytes.length,
      },
      bytes,
    },
  ];
  const native = await fixture({ codeInputs, pdf: true });
  expect((await native.drain()).at(-1)?.type).toBe("run.completed");
  expect(native.messages[0]?.content).toEqual([
    { type: "text", text: expect.stringContaining("work") },
    {
      type: "file",
      source_type: "base64",
      mime_type: "application/pdf",
      data: bytes.toString("base64"),
    },
  ]);
  const textual = await fixture({ codeInputs, pdf: false, vision: false });
  expect((await textual.drain()).at(-1)?.type).toBe("run.completed");
  expect(textual.messages[0]?.content).toEqual([
    { type: "text", text: expect.stringContaining("work") },
    { type: "text", text: expect.stringContaining("Hello PDF") },
  ]);
});

it("Code主运行无需Canvas，快照钩子绑定同一持久Task目录", async () => {
  const f = await fixture();
  expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(true);
  expect((await f.drain()).at(-1)?.type).toBe("run.completed");
  expect(f.calls).toEqual([
    {
      hook: "before",
      taskId: f.scope.taskId,
      root: f.scope.rootDirectory,
      role: "main",
    },
    {
      hook: "after",
      taskId: f.scope.taskId,
      root: f.scope.rootDirectory,
      role: "main",
    },
  ]);
  expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
});

it("factory失败仍保存收尾快照，保留真实run.failed原因", async () => {
  const f = await fixture({ failFactory: true });
  expect((await f.drain()).at(-1)).toMatchObject({
    type: "run.failed",
    error: { message: expect.stringContaining("factory failed") },
  });
  expect(f.calls.map((call) => call.hook)).toEqual(["after"]);
});

it("检查点旁路失败不把成功运行改成失败", async () => {
  const f = await fixture({ failHook: true });
  expect((await f.drain()).at(-1)?.type).toBe("run.completed");
  expect(f.calls.map((call) => call.hook)).toEqual(["before", "after"]);
});

it("durable eventSink失败在结束stream前中止原Run工具signal", async () => {
  const f = await fixture({ failSink: true });
  await expect(f.drain()).rejects.toThrow("event persistence failed");
  expect(f.signals[0]?.aborted).toBe(true);
  expect(f.runtime.hasActiveRunForTask(f.scope.taskId)).toBe(false);
});

it("真实运行取消等待公共stream收尾并保存快照", async () => {
  const f = await fixture({ hang: true });
  const completed = f.drain();
  await f.started;
  await f.runtime.cancelRunAndWait(f.created.runId);
  expect((await completed).at(-1)?.type).toBe("run.canceled");
  expect(f.calls.map((call) => call.hook)).toEqual(["before", "after"]);
});

it.each(["explore", "review", "worker"] as const)(
  "%s复用相同factory但不执行主Task快照或命令hook，角色指令进入prompt",
  async (role) => {
    const f = await fixture({ role });
    expect((await f.drain()).at(-1)?.type).toBe("run.completed");
    expect(f.calls).toEqual([]);
    expect(f.prompts[0]).toContain("readonly evidence");
  },
);
