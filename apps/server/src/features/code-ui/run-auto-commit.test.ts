import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instanceSettingsSchema,
  zcodeUiProtocol as protocol,
  providerInstanceResponseSchema,
  type StreamEvent,
} from "@kenfutwork/shared";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiTestInstance } from "./host-session.fixture.js";
import type { CodeUiRepository, CodeUiSessionRecord } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * 最小装配：真实 conversation reducer + 内存 repository，经 `admitExternalRun`
 * 经canonical输入、publisher和真实执行器eventSink进入终态投影（G3/Q8 接线验证）。
 */
async function fixture(options: { withCodeGit?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kfw-code-autocommit-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const instanceId = randomUUID();
  const actor = { instanceId, accessClientId: null };
  const projectId = randomUUID();
  const taskId = randomUUID();
  const provider = providerInstanceResponseSchema.parse({
    id: randomUUID(),
    scope: "local",
    name: "Auto commit test",
    protocol: "openai-compatible",
    hasCredential: true,
    configRevision: 1,
    headerKeys: [],
    enabled: true,
    models: [
      {
        id: "test",
        name: "Test",
        capability: "chat",
        vision: true,
        inputModalities: ["text", "image", "pdf"],
        reasoningEfforts: ["low", "high"],
      },
    ],
    compat: {
      codeUi: {
        models: {
          test: {
            useRecommendedConfig: true,
            config: {
              optionSpecs: {
                reasoningLevel: { map: '{"reasoning_effort": reasoningLevel}' },
              },
            },
          },
        },
      },
    },
  });
  const selection = {
    providerId: provider.id,
    modelId: "test",
    options: { reasoningLevel: "low" },
  };
  const scope = {
    instanceId,
    projectId,
    taskId,
    rootDirectory: directory,
    additionalDirectories: [],
    sandboxMode: "workspace-write" as const,
    generation: 1,
  };
  const conversation = createCodeUiConversation({
    sessionId: taskId,
    workspacePath: directory,
    config: {
      provider: "zcode",
      model: "test",
      thought: "",
      followupMode: "queue",
      modelSelection: selection,
    },
  });
  const root: CodeUiSessionRecord = {
    id: taskId,
    instance_id: instanceId,
    project_id: projectId,
    root_directory: directory,
    additional_directories: [],
    sandbox_mode: "workspace-write",
    scope_generation: 1,
    branch_generation: 1,
    execution_state: "ready",
    chat_session_id: taskId,
    root_session_id: taskId,
    parent_session_id: null,
    parent_tool_call_id: null,
    state: conversation.exportState(),
    revision: 0,
    active_run_id: null,
    archived: false,
    pinned: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  const commands = new Map<
    string,
    { fingerprint: string; ack: protocol.CommandAck }
  >();
  const events = new Map<string, string>();
  let sink: ((event: StreamEvent) => Promise<void>) | undefined;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let signalFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    signalFinished = resolve;
  });
  const creates = vi.fn();
  const repository = {
    preparations: {
      recover: async () => {},
      begin: async () => randomUUID(),
      remove: async () => {},
      planObject: async () => {},
    },
    recoverRuntimeInputs: async () => {},
    readRunFailure: async () => null,
    async startRunIfCurrent(workspace, task, runId, expected, start) {
      const input = root.state?.inputs?.find((entry) => entry.runId === runId);
      if (
        workspace !== instanceId ||
        task !== taskId ||
        root.active_run_id !== runId ||
        root.execution_state !== "ready" ||
        input?.status !== "active" ||
        Number(root.scope_generation) !== expected.scopeGeneration ||
        Number(root.branch_generation) !== expected.branchGeneration
      )
        return false;
      start(structuredClone(root));
      return true;
    },
    readHumanPreferences: async () => ({}),
    find: async (workspace: string, id: string) =>
      workspace === instanceId && id === taskId ? structuredClone(root) : null,
    list: async () => [structuredClone(root)],
    listRoots: async () => [structuredClone(root)],
    listVersion: async () => Number(root.revision),
    async applyCommand(_workspace, envelope, fingerprint, decide) {
      const key = JSON.stringify([envelope.clientId, envelope.commandId]);
      const previous = commands.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("command_conflict");
        return { ...previous.ack, status: "duplicate" as const };
      }
      const decision = decide(structuredClone(root));
      if (decision.state) {
        root.state = decision.state;
        root.active_run_id = decision.activeRunId;
        root.revision = Number(root.revision) + 1;
      }
      const ack = protocol.commandAckSchema.parse(decision.ack);
      commands.set(key, { fingerprint, ack });
      return ack;
    },
    /** 与真实 appendEvent 同口径：同 key 重复事件返回 false（不重放 decide）。 */
    async appendEvent(_workspace, _task, input, apply) {
      const known = events.get(input.key);
      if (known) {
        if (known !== input.fingerprint) throw new Error("command_conflict");
        return false;
      }
      const decision = apply(structuredClone(root));
      root.state = decision.state;
      root.active_run_id = decision.activeRunId;
      root.revision = Number(root.revision) + 1;
      events.set(input.key, input.fingerprint);
      return true;
    },
    async queryCommands(_workspace, client, query) {
      return {
        results: query.map((input) => {
          const value = commands.get(JSON.stringify([client, input.commandId]));
          return { key: input, result: value?.ack ?? ("unknown" as const) };
        }),
      };
    },
  } satisfies Partial<CodeUiRepository>;
  const autoCommitRun = vi.fn(async () => {});
  const service = new CodeUiService({
    repository,
    blob: createLocalFsBlobStore({
      rootDir: directory,
      publicBaseUrl: "http://localhost/blob",
      signingSecret: "private-auto-commit-test",
    }),
    localInstance: createCodeUiTestInstance(instanceId).localInstance,
    projects: {
      listProjects: async () => [
        {
          id: projectId,
          kind: "code" as const,
          name: "Test",
          workDir: directory,
          additionalDirectories: [],
        },
      ],
    },
    modelProviders: {
      listInstances: async () => [provider],
      listProviderPresets: () => [],
    },
    modelCatalog: { listCatalog: async () => [] },
    settings: {
      getInstanceSettings: async () =>
        instanceSettingsSchema.parse({ defaultModel: "test" }),
    },
    threads: {
      resolveOwnedSessionThread: async () => ({ threadId: `thread:${taskId}` }),
    },
    executionScopes: { openTask: async () => ({ describe: () => scope }) },
    agentRunMetadata: {
      createAcceptedRun: vi.fn(async () => {}),
      updateRun: vi.fn(async () => {}),
    },
    agentRuns: {
      createRun: (
        _request: unknown,
        options: {
          runId: string;
          eventSink: (event: StreamEvent) => Promise<void>;
        },
      ) => {
        creates(options.runId);
        sink = options.eventSink;
        signalStarted();
        return { runId: options.runId };
      },
      async *streamRun() {
        await finished;
        yield* [];
      },
      cancelRun() {},
      cancelRunAndWait: async () => {},
    },
    taskWork: {
      initialize: async () => [],
      notifyReady: async () => {},
      list: async () => [],
    },
    env: {},
    ...(options.withCodeGit === false ? {} : { codeGit: { autoCommitRun } }),
  } as unknown as CodeUiServiceDeps);
  cleanups.push(() => service.closeConnections());
  cleanups.push(async () => {
    signalFinished();
  });
  const scopeHandle = {
    describe: () => scope,
  };
  return {
    actor,
    taskId,
    service,
    autoCommitRun,
    scopeHandle,
    started,
    creates,
    finish: signalFinished,
    send: async (event: StreamEvent) => {
      if (!sink) throw new Error("canonical执行器未启动");
      await sink(event);
    },
  };
}

it("canonical Run终态触发自动提交，非终态与准入重放不重复触发", async () => {
  const f = await fixture();
  const inputId = randomUUID();
  const admission = await f.service.admitExternalRun(
    f.actor,
    f.scopeHandle as never,
    inputId,
    "做点改动",
  );
  const running = admission.publish();
  await f.started;
  const runId = admission.runId;
  expect(runId).not.toBe(inputId);
  await f.send({
    type: "run.usage",
    runId,
    inputTokens: 1,
    outputTokens: 1,
    timestamp: new Date().toISOString(),
  } as StreamEvent);
  expect(f.autoCommitRun).not.toHaveBeenCalled();
  const replay = await f.service.admitExternalRun(
    f.actor,
    f.scopeHandle as never,
    inputId,
    "做点改动",
  );
  expect(replay.runId).toBe(runId);
  await replay.publish();
  await f.send({
    type: "message.delta",
    runId,
    messageId: randomUUID(),
    delta: "本轮变更已处理",
    timestamp: new Date().toISOString(),
  });
  await f.send({
    type: "run.completed",
    runId,
    timestamp: new Date().toISOString(),
  } as StreamEvent);
  f.finish();
  await running;
  expect(f.creates).toHaveBeenCalledTimes(1);
  expect(f.autoCommitRun).toHaveBeenCalledTimes(1);
  expect(f.autoCommitRun).toHaveBeenCalledWith(f.actor, f.taskId);
});

it("未装配codeGit时canonical终态仍正常落库", async () => {
  const f = await fixture({ withCodeGit: false });
  const admission = await f.service.admitExternalRun(
    f.actor,
    f.scopeHandle as never,
    randomUUID(),
    "做点改动",
  );
  const running = admission.publish();
  await f.started;
  await expect(
    f.send({
      type: "run.failed",
      runId: admission.runId,
      error: { code: "run_failed", message: "上游拒绝" },
      timestamp: new Date().toISOString(),
    } as StreamEvent),
  ).resolves.toBeUndefined();
  f.finish();
  await running;
  expect((await f.service.getSnapshot(f.actor, f.taskId)).control.phase).toBe(
    "error",
  );
});
