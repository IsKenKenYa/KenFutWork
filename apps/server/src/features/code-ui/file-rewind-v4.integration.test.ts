import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { HumanMessage } from "@langchain/core/messages";
import { createAgent, FakeToolCallingModel } from "langchain";
import { describe, expect, it } from "vitest";
import { kernelToolToStructuredTool } from "../../agent/kernel-tools-bridge.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { adaptDeepAgentStream } from "../../agent/stream-adapter.js";
import { loadServerEnv } from "../../config/env.js";
import {
  AgentRunEventBus,
  CapabilityRegistryImpl,
  ToolRegistryImpl,
} from "../../kernel/context.js";
import { createAgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import type { AgentTurnBoundary } from "../agent-runs/types.js";
import { createViewerService } from "../bootstrap/ensure-user-foundation.js";
import { createViewerRepository } from "../bootstrap/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createCheckpointService } from "../checkpoints/checkpoint-service.js";
import { createCheckpointRepository } from "../checkpoints/repository.js";
import { createShadowGitClient } from "../checkpoints/shadow-git-client.js";
import { createShadowGitExec } from "../checkpoints/shadow-git-exec.js";
import { createCodeFileTools } from "../code-tools/tool-definitions.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { acquireTaskFileRestoreBarrier } from "../execution/scoped-filesystem.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { createProjectService } from "../projects/project-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createCodeUiConversation } from "./conversation.js";
import { createCodeUiRepository } from "./repository.js";
import { CodeUiService, type CodeUiServiceDeps } from "./service.js";
import { createToolLifecycleMiddleware } from "./tool-lifecycle.js";

type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;
async function ownedTask(database: Database) {
  const { scope } = database.context;
  const owner = await database.persistence.queryOne<{ owner_user_id: string }>(
    "select owner_user_id from public.workspaces where id=$1",
    [scope.workspaceId],
  );
  if (!owner) throw new Error("隔离工作区不存在");
  const actor = {
    id: owner.owner_user_id,
    email: "file-rewind@integration.test",
    accessToken: "private",
    userMetadata: {},
  };
  const threadId = `file-rewind-${randomUUID()}`;
  await database.persistence
    .forWorkspace(scope.workspaceId)
    .execute(
      "insert into public.chat_sessions (id,workspace_id,project_id,mode,created_by,thread_id) values ($1,:workspace,$2,'code',$3,$4)",
      [scope.taskId, scope.projectId, actor.id, threadId],
    );
  await database.persistence
    .forWorkspace(scope.workspaceId)
    .execute(
      "update public.code_ui_sessions set chat_session_id=$1 where workspace_id=:workspace and id=$1",
      [scope.taskId],
    );
  const viewer = createViewerService({
    repository: createViewerRepository(database.persistence),
  });
  const threads = createThreadService({
    repository: createChatRepository(database.persistence),
    viewerService: viewer,
  });
  const metadata = createAgentRunMetadataService({
    repository: createAgentRunRepository(database.persistence),
    viewerService: viewer,
    threadService: threads,
  });
  const settings = createSettingsService({
    repository: createSettingsRepository(database.persistence),
  });
  const scopes = createExecutionScopes({
    repository: createScopeRepository(database.persistence),
    viewerService: viewer,
    resolveFileLimits: (user, current) =>
      settings.getWorkspaceSettings(user, current.workspaceId),
  });
  const handle = await scopes.openTask(actor, scope.taskId);
  const repository = createCodeUiRepository(database.persistence);
  await repository.save(
    scope.workspaceId,
    scope.taskId,
    0,
    createCodeUiConversation({
      sessionId: scope.taskId,
      workspacePath: scope.rootDirectory,
      config: {
        provider: "zcode",
        model: "fixture",
        thought: "",
        followupMode: "queue",
      },
    }).exportState(),
    null,
  );
  return {
    scope,
    actor,
    threadId,
    viewer,
    threads,
    metadata,
    settings,
    scopes,
    handle,
    repository,
    branchGeneration: database.context.branchGeneration,
  };
}

async function hostFixture(database: Database) {
  const binding = await ownedTask(database);
  const checkpointRoot = join(database.directory, "checkpoints");
  // Darwin /usr/bin/git为developer selector入口；既有gitBinDir缝指向xcrun核实的实际安装二进制。
  const gitBinDir =
    process.platform === "darwin"
      ? dirname(
          execFileSync("xcrun", ["--find", "git"], { encoding: "utf8" }).trim(),
        )
      : undefined;
  const gitBinary = gitBinDir ? join(gitBinDir, "git") : "git";
  await mkdir(checkpointRoot);
  const sandbox = createProcessSandbox({
    captureRoot: join(database.directory, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
    resolveInternalWriteRoots: async (scope) => [
      join(
        checkpointRoot,
        scope.workspaceId,
        scope.projectId,
        `${scope.taskId}.git`,
      ),
    ],
  });
  const work = createTaskWorkManager({
    store: createTaskWorkStore(database.persistence),
    executionHostId: database.directory,
    resolveMaxConcurrent: async (context) =>
      (
        await binding.settings.getWorkspaceSettings(
          binding.actor,
          context.scope.workspaceId,
        )
      ).subagentMaxConcurrency,
  });
  const env = loadServerEnv({
    agentBackendMode: "filesystem",
    agentFilesRoot: database.directory,
    checkpointRoot,
    ...(gitBinDir ? { gitBinDir } : {}),
    gitSource: "system",
  });
  const runtime = createAgentRunService({
    blob: {} as never,
    env,
    model: new FakeToolCallingModel({ toolCalls: [] }),
    agentPersistenceService: createAgentPersistenceService({}),
    agentRunMetadataService: binding.metadata,
  });
  const capabilities = new CapabilityRegistryImpl();
  const closer = createTaskResourceCloser({
    viewer: binding.viewer,
    resources: () => ({ runs: runtime, work, sandbox, capabilities }),
  });
  let host: CodeUiService | undefined;
  const checkpoints = createCheckpointService({
    repository: createCheckpointRepository(database.persistence),
    gitSource: "system",
    checkpointRoot,
    gitForScope: async (scope, actor) => {
      const settings = await binding.settings.getWorkspaceSettings(
        actor,
        scope.describe().workspaceId,
      );
      return createShadowGitClient({
        exec: createShadowGitExec({
          scope: scope.derive("review", "checkpoint-git"),
          sandbox,
          binary: gitBinary,
          timeoutMs: settings.executeTimeoutMs,
          limits: {
            maxOutputBytes: settings.processMaxOutputBytes,
            previewMaxChars: settings.processPreviewMaxChars,
            yieldMs: settings.processYieldMs,
            killGraceMs: settings.processKillGraceMs,
          },
        }),
        writeTextFile: async (path, text) => {
          await writeFile(path, text, "utf8");
        },
      });
    },
    files: {
      observe: (scope, path) => scope.backend.observeBinary(path),
      commit: async (scope, entries, beforeCommit) => {
        const result = await scope.backend.commitBatch(entries, beforeCommit);
        if (!result.complete || !result.newScope)
          throw new Error("真实检查点批量恢复未完成");
        return result.newScope;
      },
    },
    acquireRestoreBarrier: async (scope, roots) => {
      const processLease = await sandbox.acquireRestoreBarrier(
        scope.describe(),
        roots,
      );
      try {
        const fileLease = await acquireTaskFileRestoreBarrier(scope, roots);
        return {
          authorize: (next) => fileLease.authorize(next),
          release: async () => {
            try {
              await fileLease.release();
            } finally {
              await processLease.release();
            }
          },
        };
      } catch (error) {
        await processLease.release();
        throw error;
      }
    },
    onBeforeRestore: async (scope, actor) => {
      if (!host) throw new Error("原V4宿主未安装");
      return host.rewindTask(
        actor,
        scope.describe().taskId,
        scope.describe().generation,
      );
    },
    onAfterRestore: async (scope, actor, success) => {
      if (!host) throw new Error("原V4宿主未安装");
      await host.finishTaskRestore(scope, actor, success);
    },
  });
  const instances: CodeUiService[] = [];
  const createHost = () => {
    // 空BYOK目录是外部模型目录边界；文件、身份、日志、恢复与执行域均使用真实provider。
    host = new CodeUiService({
      repository: createCodeUiRepository(database.persistence),
      viewer: binding.viewer,
      threads: binding.threads,
      projects: createProjectService({
        repository: createProjectRepository(database.persistence),
        viewerService: binding.viewer,
        blob: {} as never,
      }),
      settings: binding.settings,
      executionScopes: binding.scopes,
      agentRunMetadata: binding.metadata,
      checkpoints,
      processSandbox: sandbox,
      taskWork: work,
      agentRuns: runtime,
      beforeCloseTask: closer,
      modelProviders: {
        listInstances: async () => [],
        listProviderPresets: () => [],
      },
      modelCatalog: { listCatalog: async () => [] },
      env,
    } as unknown as CodeUiServiceDeps);
    instances.push(host);
    return host;
  };
  return {
    ...binding,
    sandbox,
    checkpoints,
    work,
    createHost,
    async close() {
      for (const item of instances) await item.closeConnections();
      await work.close("integration cleanup");
      await sandbox.close("integration cleanup");
    },
  };
}

async function nativeTurn(
  fixture: Awaited<ReturnType<typeof hostFixture>>,
  host: CodeUiService,
) {
  const runId = randomUUID();
  const inputMessageId = randomUUID();
  const input = new HumanMessage({
    id: inputMessageId,
    content: "把before改为after，保留聊天",
  });
  await fixture.metadata.createAcceptedRun({
    runId,
    sessionId: fixture.scope.taskId,
    threadId: fixture.threadId,
  });
  const sink = await host.admitExternalRun(
    fixture.actor,
    fixture.handle,
    runId,
    "把before改为after，保留聊天",
  );
  const boundary = async (phase: AgentTurnBoundary["phase"]) => {
    const captured = await fixture.checkpoints.captureTurnBoundary({
      scope: fixture.handle,
      actor: fixture.actor,
      runId,
      phase,
    });
    await fixture.metadata.recordTurnBoundary({
      workspaceId: fixture.scope.workspaceId,
      projectId: fixture.scope.projectId,
      taskId: fixture.scope.taskId,
      runId,
      threadId: fixture.threadId,
      phase,
      scopeGeneration: fixture.scope.generation,
      branchGeneration: fixture.branchGeneration,
      inputIdentity: {
        clientId: "host.agent-runs",
        sourceCommandId: `agent-run:${runId}`,
      },
      inputOrigin: "userInput",
      inputMessageId,
      context: {
        status: "unavailable",
        reason: "file-only integration fixture",
      },
      files: { status: "captured", reference: captured.effective?.id ?? null },
    });
  };
  await boundary("pre");
  const definitions = createCodeFileTools({
    backend: fixture.handle.backend,
    modelCapabilities: { image: false, pdf: false },
  });
  const read = definitions.find((entry) => entry.name === "Read");
  const edit = definitions.find((entry) => entry.name === "Edit");
  if (!read || !edit) throw new Error("真实native文件工具缺失");
  const registry = new ToolRegistryImpl(new AgentRunEventBus());
  registry.register(read);
  registry.register(edit);
  const agent = createAgent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            id: "read-source",
            name: "Read",
            args: { file_path: "encoded.txt" },
          },
        ],
        [
          {
            id: "edit-source",
            name: "Edit",
            args: {
              file_path: "encoded.txt",
              old_string: "before",
              new_string: "after",
            },
          },
        ],
        [],
      ],
    }),
    tools: [kernelToolToStructuredTool(read), kernelToolToStructuredTool(edit)],
    middleware: [
      createToolLifecycleMiddleware(
        {},
        {
          registry,
          resolution: {
            preset: "code",
            backendFactory: () => {
              throw new Error("公开文件源不能创建第二工作域");
            },
          },
          execution: {},
        },
      ),
    ],
  });
  for await (const event of adaptDeepAgentStream({
    conversationId: fixture.scope.taskId,
    sessionId: fixture.scope.taskId,
    runId,
    canonicalToolEvents: true,
    stream: agent.streamEvents({ messages: [input] }, { version: "v2" }),
  }))
    await sink(event);
  await boundary("post");
  await fixture.metadata.updateRun({
    runId,
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  return runId;
}

async function connect(
  host: CodeUiService,
  actor: Parameters<CodeUiService["openConnection"]>[0],
  clientId: string,
) {
  const connection = await host.openConnection(
    actor,
    async () => {},
    () => {},
  );
  const rpc = (method: string, value: unknown) =>
    host.transportRpc(actor, connection.hello.connectionId, method, [value]);
  await rpc("initializeConversationV4", {
    kind: "clientHello",
    clientId,
    protocolVersion: protocol.V4_WIRE_PROTOCOL_VERSION,
    clientKind: "web",
    appVersion: "file-rewind integration",
  });
  return rpc;
}

/** 独立一次性本机PG集群；不读取.env，不连接任何现存数据库。 */
describe.skipIf(process.env.KENFUTWORK_CODE_INPUT_TEST_PG !== "1")(
  "原V4文件恢复完整持久链 integration",
  () => {
    it("原RPC preview/apply经精确snapshot与真实barrier恢复，cold聊天与reverted保留，旧CAS重放duplicate不二次执行", async () => {
      const database = await createTaskWorkDatabase();
      let fixture: Awaited<ReturnType<typeof hostFixture>> | undefined;
      try {
        fixture = await hostFixture(database);
        const path = join(fixture.scope.rootDirectory, "encoded.txt");
        const original = Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from("before\n", "utf16le"),
        ]);
        await writeFile(path, original);
        await chmod(path, 0o600);
        const first = fixture.createHost();
        const runId = await nativeTurn(fixture, first);
        const before = protocol.conversationSnapshotSchema.parse(
          await first.getSnapshot(fixture.actor, fixture.scope.taskId),
        );
        const header = before.rows.window.find(
          (row) => row.kind === "turnHeader" && row.turnId === runId,
        );
        if (!header?.entityId) throw new Error("真实源缺少轮次身份");
        const chats = before.rows.window.filter(
          (row) => row.kind === "userInput" || row.kind === "assistantText",
        );
        expect(
          chats.some(
            (row) =>
              row.kind === "userInput" &&
              row.text === "把before改为after，保留聊天",
          ),
        ).toBe(true);
        expect(
          chats.some(
            (row) => row.kind === "assistantText" && row.text.length > 0,
          ),
        ).toBe(true);
        expect(await readFile(path)).toEqual(
          Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from("after\n", "utf16le"),
          ]),
        );
        const clientId = randomUUID();
        const rpc = await connect(first, fixture.actor, clientId);
        const target = {
          workspacePath: fixture.scope.rootDirectory,
          projectId: fixture.scope.projectId,
          workspaceIdentity: JSON.stringify([
            fixture.scope.projectId,
            fixture.scope.rootDirectory,
          ]),
        };
        const params = {
          ...target,
          sessionId: fixture.scope.taskId,
          target: { rowId: header.rowId, entityId: header.entityId },
          baseRevision: before.revision,
          baseLogEpoch: before.logEpoch,
        };
        const previewReply = await rpc(
          "conversationFileRewindPreviewV4",
          params,
        );
        const preview =
          protocol.v4ConversationFileRewindPreviewResultSchema.parse(
            previewReply?.result,
          );
        expect(preview).toEqual({
          canApply: true,
          safeFiles: [
            { path, action: "restore", operationCount: 1, toolNames: ["Edit"] },
          ],
          unsafeFiles: [],
          ignoredFiles: [],
        });
        expect(JSON.stringify(preview)).not.toContain("before");
        const command: protocol.CommandEnvelope = {
          clientId,
          commandId: randomUUID(),
          sessionId: fixture.scope.taskId,
          type: "applyFileRewind",
          payload: { target: params.target },
          baseRevision: before.revision,
          baseLogEpoch: before.logEpoch,
          issuedAt: Date.now(),
        };
        const applied = await rpc("sendConversationCommandV4", {
          ...target,
          envelope: command,
        });
        expect(protocol.commandAckSchema.parse(applied?.result)).toMatchObject({
          status: "accepted",
          result: { type: "applyFileRewind", applied: true },
        });
        expect(await readFile(path)).toEqual(original);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        await first.closeConnections();
        const cold = fixture.createHost();
        const restored = protocol.conversationSnapshotSchema.parse(
          await cold.getSnapshot(fixture.actor, fixture.scope.taskId),
        );
        expect(
          restored.rows.window.filter(
            (row) => row.kind === "userInput" || row.kind === "assistantText",
          ),
        ).toEqual(chats);
        expect(
          restored.rows.window.find((row) => row.rowId === header.rowId),
        ).toMatchObject({
          kind: "turnHeader",
          fileChanges: { files: 1, state: "reverted" },
        });
        const freshScope = await fixture.scopes.openTask(
          fixture.actor,
          fixture.scope.taskId,
        );
        expect(freshScope.describe().generation).toBe(
          fixture.scope.generation + 1,
        );
        await expect(
          fixture.handle.backend.readPage({ path }),
        ).rejects.toMatchObject({ code: "branch_changed" });
        await writeFile(path, "external-after-rewind\n");
        const version = (await freshScope.backend.observeBinary(path)).version;
        const coldRpc = await connect(cold, fixture.actor, clientId);
        const replay = await coldRpc("sendConversationCommandV4", {
          ...target,
          envelope: command,
        });
        expect(protocol.commandAckSchema.parse(replay?.result)).toMatchObject({
          status: "duplicate",
          result: { type: "applyFileRewind", applied: true },
        });
        expect(await readFile(path, "utf8")).toBe("external-after-rewind\n");
        expect((await freshScope.backend.observeBinary(path)).version).toBe(
          version,
        );
        expect(
          (await cold.getSnapshot(fixture.actor, fixture.scope.taskId))
            .revision,
        ).toBe(restored.revision);
        expect(await freshScope.backend.readPage({ path })).toMatchObject({
          content: "external-after-rewind\n",
        });
      } finally {
        await fixture?.close();
        await database.close();
      }
    });
  },
);

import { execFileSync } from "node:child_process";
