import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_GOVERNANCE_DEFAULTS,
  zcodeUiProtocol as protocol,
  type StreamEvent,
} from "@kenfutwork/shared";
import { ChatOpenAI } from "@langchain/openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createNativeContextBranchService } from "../../agent/native-context-branch.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import type { AgentRunExtension } from "../../agent/run-extension.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { ToolDeniedError } from "../../kernel/context.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { prepareHarnessTask } from "../agent-runs/test-harness.js";
import { createLocalFsBlobStore } from "../blob/providers/local-fs.js";
import { createCodeUiAgentEventsPlugin } from "../code-ui/agent-events-plugin.js";
import {
  type CodeUiConversationState,
  createCodeUiConversation,
} from "../code-ui/conversation.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { createPermissionsPlugin } from "../permissions/plugin.js";
import { buildBundleManifest } from "../plugins/bundle-manifest.js";
import { validateBundleFiles } from "../plugins/compat-validator.js";
import { createPluginRegistryService } from "../plugins/plugin-registry-service.js";
import { createPluginStorage } from "../plugins/plugin-storage.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkStore } from "../task-work/repository.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createToolCatalogPlugin } from "../tool-catalog/plugin.js";
import { createDesktopModelServer } from "./fixtures/model-server.js";
import type { ComputerUseMcpExport } from "./mcp-server.js";
import { createComputerUsePlugin } from "./plugin.js";
import { CU_BUNDLE_ID, CU_TOOL_PREFIX } from "./tools.js";

const exec = promisify(execFile);
type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;
const enabled =
  process.platform === "darwin" && process.env.KENFUTWORK_TEST_DESKTOP === "1";

async function installedKernel(
  database: Database,
  env: ReturnType<typeof loadServerEnv>,
) {
  const root = new URL("../../../../../plugins/computer-use/", import.meta.url);
  const files: Record<string, string> = {};
  for (const name of [
    "package.json",
    "index.js",
    "cordis.patch.yml",
    "README.md",
  ])
    files[name] = await readFile(new URL(name, root), "utf8");
  const { manifest } = buildBundleManifest(files);
  const report = validateBundleFiles(files, {
    hostNodeMajor: Number(process.versions.node.split(".")[0]),
    allowLifecycleScripts: false,
    fallbackName: CU_BUNDLE_ID,
  });
  const settings = createSettingsService({
    repository: createSettingsRepository(database.persistence),
    localInstance: database.localInstance,
  });
  const bundlePlugin: PluginDefinition = {
    name: "native-test:real-installed-bundle",
    inject: [],
    apply(ctx) {
      ctx.register("plugins", () =>
        createPluginRegistryService({
          pluginsDir: join(database.directory, "plugins"),
          tools: ctx.get("tools"),
          builtinCatalog: [],
          bundledBundles: [
            {
              id: `local__${CU_BUNDLE_ID}`,
              name: CU_BUNDLE_ID,
              files,
              manifest,
              report,
            },
          ],
          hostNodeMajor: Number(process.versions.node.split(".")[0]),
          storage: createPluginStorage({ persistence: database.persistence }),
          // 此真实自带bundle的apply为空，既不注册事件也不请求额外能力。
          subscribe: () => () => {},
        }),
      );
      ctx.effect(() => () => ctx.get("plugins").shutdown());
    },
  };
  const app = Fastify();
  const kernel = composePlugins(
    env,
    [
      bundlePlugin,
      createPermissionsPlugin({}),
      createComputerUsePlugin(),
      createToolCatalogPlugin(),
      createCodeUiAgentEventsPlugin(),
    ],
    {
      app,
      overrides: {
        settings,
        localInstance: database.localInstance,
        localAccess: database.localAccess,
        persistence: database.persistence,
      },
    },
  );
  await kernel
    .get("plugins")
    .install({ builtin: CU_BUNDLE_ID, allowLifecycleScripts: false });
  return { app, kernel, settings };
}

async function taskRuntime(
  database: Database,
  installed: Awaited<ReturnType<typeof installedKernel>>,
  env: ReturnType<typeof loadServerEnv>,
  model: ChatOpenAI,
) {
  const task = await prepareHarnessTask(database);
  const scopes = createExecutionScopes({
    repository: createScopeRepository(database.persistence),
    localInstance: database.localInstance,
  });
  const handle = await scopes.openTask(task.actor, task.scope.taskId);
  const host = createCodeUiConversation({
    sessionId: task.scope.taskId,
    workspacePath: task.scope.rootDirectory,
    config: {
      provider: "zcode",
      model: "desktop-fixture",
      thought: "",
      followupMode: "queue",
      mode: "yolo",
    },
  });
  await database.persistence
    .forInstance(task.scope.instanceId)
    .execute(
      "update public.code_ui_sessions set state=$2::jsonb where instance_id=:instance and id=$1",
      [task.scope.taskId, JSON.stringify(host.exportState())],
    );
  const work = createTaskWorkManager({
    store: createTaskWorkStore(database.persistence),
    executionHostId: database.directory,
    resolveMaxConcurrent: async () =>
      (
        await installed.settings.getInstanceSettings(
          task.actor,
          task.scope.instanceId,
        )
      ).subagentMaxConcurrency,
  });
  const persistence = createAgentPersistenceService({
    databaseUrl: database.connectionString,
  });
  const runtime = createAgentRunService({
    env,
    model,
    localInstance: task.localInstance,
    blob: createLocalFsBlobStore({
      rootDir: join(database.directory, "blob"),
      publicBaseUrl: "http://127.0.0.1/unused-blobs",
      signingSecret: "desktop-fixture-signing",
    }),
    agentRunMetadataService: task.metadata(),
    agentPersistenceService: persistence,
    contextBranchProvider: createNativeContextBranchService({
      agentPersistenceService: persistence,
    }),
    tools: installed.kernel.get("tools"),
    settingsService: installed.settings,
    taskWork: work,
    runExtensions: () =>
      installed.kernel
        .get("capabilities")
        .list<AgentRunExtension>("agent-run-extension")
        .map((item) => item.value),
    emitTurnStopping: (payload) =>
      installed.kernel.events.emitTurnStopping(payload),
    resolveTaskWorkContext: async (actor, current, runId) => ({
      actor,
      scope: current.describe(),
      agentId: current.agentId,
      runId,
      branchGeneration: 1,
    }),
    resolveCodeApprovalMode: async (current) => {
      const scope = current.describe();
      const row = await database.persistence
        .forInstance(scope.instanceId)
        .queryOne<{
          state: CodeUiConversationState;
          scope_generation: number;
          branch_generation: number;
        }>(
          "select state,scope_generation,branch_generation from public.code_ui_sessions where instance_id=:instance and id=$1 and execution_state='ready' and deleted_at is null",
          [scope.taskId],
        );
      if (!row) throw new Error("真实Task授权已失效");
      const config = row.state.snapshots.find(
        (snapshot) => snapshot.sessionId === scope.taskId,
      )?.config;
      return {
        mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse({
          mode: config?.mode,
        }).mode,
        scopeGeneration: Number(row.scope_generation),
        branchGeneration: Number(row.branch_generation),
      };
    },
  });
  return { ...task, handle, host, runtime, work, persistence };
}

describe.skipIf(!enabled)("真实macOS Task→插件→Agent→模型HTTP→V4事件", () => {
  it(
    "持久Task实际调用CUA，模型HTTP拿到PNG且原V4行保留结果",
    async () => {
      const database = await createTaskWorkDatabase();
      let fixture: ReturnType<typeof spawn> | undefined;
      let installed: Awaited<ReturnType<typeof installedKernel>> | undefined;
      let task: Awaited<ReturnType<typeof taskRuntime>> | undefined;
      let modelServer:
        | Awaited<ReturnType<typeof createDesktopModelServer>>
        | undefined;
      let mcpClient: Client | undefined;
      let mcpServer: Server | undefined;
      let pumping: Promise<void> | undefined;
      let activeRunId: string | undefined;
      let resumeModel = () => {};
      let modelStarted!: () => void;
      const firstRequest = new Promise<void>((resolve) => {
        modelStarted = resolve;
      });
      const responseGate = new Promise<void>((resolve) => {
        resumeModel = resolve;
      });
      const events: StreamEvent[] = [];
      try {
        const executable = join(database.directory, "desktop-probe");
        await exec("swiftc", [
          new URL("./fixtures/desktop.swift", import.meta.url).pathname,
          "-module-cache-path",
          join(database.directory, "swift-cache"),
          "-o",
          executable,
        ]);
        fixture = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
        await once(fixture.stdout!, "data");
        modelServer = await createDesktopModelServer(fixture.pid!, {
          beforeResponse: async (stage) => {
            if (stage === 0) {
              modelStarted();
              await responseGate;
            }
          },
        });
        const env = loadServerEnv({
          agentBackendMode: "filesystem",
          agentFilesRoot: database.directory,
          checkpointRoot: join(database.directory, "checkpoints"),
        });
        installed = await installedKernel(database, env);
        task = await taskRuntime(
          database,
          installed,
          env,
          new ChatOpenAI({
            apiKey: "desktop-fixture",
            model: "desktop-fixture",
            useResponsesApi: false,
            configuration: { baseURL: modelServer.baseURL },
          }),
        );
        const { runId } = task.runtime.createRun(
          {
            sessionId: task.scope.taskId,
            conversationId: task.scope.taskId,
            projectId: task.scope.projectId,
            taskId: task.scope.taskId,
            preset: "code",
            prompt: "观察验收窗口，截屏并输入Task中文🙂🚀。",
          },
          {
            threadId: task.threadId,
            scopeHandle: task.handle,
            actor: task.actor,
            eventSink: async (event) => {
              events.push(event);
              task!.host.recordEvent(event);
            },
          },
        );
        activeRunId = runId;
        await task.metadata().createAcceptedRun({
          runId,
          sessionId: task.scope.taskId,
          threadId: task.threadId,
        });
        task.host.startTurn({
          runId,
          commandId: "desktop-native-agent",
          text: "macOS真实Task",
        });
        pumping = (async () => {
          for await (const _event of task!.runtime.streamRun(runId)) {
            // 与CodeUI生产消费者相同：持久事件只从runtime的稳定eventSink进入原V4。
          }
        })();
        await Promise.race([
          firstRequest,
          pumping.then(() => {
            throw new Error("Run在进入模型HTTP前结束");
          }),
        ]);
        const exporter = installed.kernel
          .get("capabilities")
          .list<ComputerUseMcpExport>("computer-use-mcp-export")[0]?.value;
        if (!exporter) throw new Error("真实profile未装配桌面MCP出口");
        mcpServer = exporter.createServer(task.actor, runId);
        mcpClient = new Client({
          name: "native-task-mcp-consumer",
          version: "test",
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        await mcpClient.connect(clientTransport);
        const externalState = CallToolResultSchema.parse(
          await mcpClient.callTool({
            name: "get_app_state",
            arguments: { app: { pid: fixture.pid } },
          }),
        );
        expect(
          externalState.isError,
          JSON.stringify(
            externalState.structuredContent?.error ??
              externalState.content.filter((block) => block.type === "text"),
          ),
        ).not.toBe(true);
        const externalShot = await mcpClient.callTool({
          name: "screenshot",
          arguments: { app: { pid: fixture.pid } },
        });
        expect(
          CallToolResultSchema.parse(externalShot).content.some(
            (block) => block.type === "image",
          ),
        ).toBe(true);
        await expect
          .poll(
            () =>
              events.filter((event) => event.type === "tool.started").length,
            {
              timeout: AGENT_GOVERNANCE_DEFAULTS.computerUseActionTimeoutMs,
              interval: AGENT_GOVERNANCE_DEFAULTS.computerUseInputDelayMs,
            },
          )
          .toBe(2);
        resumeModel();
        await pumping;
        await expect(
          mcpClient.callTool({
            name: "screenshot",
            arguments: { app: { pid: fixture.pid } },
          }),
        ).rejects.toThrow("活动主Code Run");
        expect(
          events.at(-1)?.type,
          JSON.stringify(
            events.filter((event) =>
              ["run.failed", "run.canceled"].includes(event.type),
            ),
          ),
        ).toBe("run.completed");
        const snapshot = protocol.conversationSnapshotSchema.parse(
          task.host.getSnapshot(),
        );
        const shot = snapshot.rows.window.find(
          (row) =>
            row.kind === "toolCall" &&
            row.toolName === `${CU_TOOL_PREFIX}screenshot`,
        );
        expect(shot?.kind).toBe("toolCall");
        if (!shot || shot.kind !== "toolCall")
          throw new Error("V4缺少真实CUA图片行");
        const display = shot.output?.display;
        if (!display || display.kind !== "cua")
          throw new Error("V4未携带CUA展示投影");
        expect(
          display.media?.some(
            (block) =>
              block.mimeType === "image/png" &&
              typeof block.data === "string" &&
              block.data.length > 0,
          ),
        ).toBe(true);
        expect(
          JSON.stringify(modelServer.requests).includes(
            "data:image/png;base64,",
          ),
        ).toBe(true);
        expect(
          JSON.stringify(modelServer.requests).includes("Task中文🙂🚀"),
        ).toBe(true);
        const finalMessages = modelServer.requests.at(-1)?.messages as Array<{
          tool_call_id?: string;
          content: unknown;
        }>;
        const observedText = finalMessages.find(
          (message) => message.tool_call_id === "desktop-model-5",
        )?.content;
        expect(JSON.stringify(observedText).includes("Task中文🙂🚀")).toBe(
          true,
        );
        expect(
          events.filter((event) => event.type === "tool.started").length,
        ).toBeGreaterThanOrEqual(6);
        await expect(
          installed.kernel
            .get("tools")
            .execute(
              `${CU_TOOL_PREFIX}screenshot`,
              { app: { pid: fixture.pid } },
              { runId, toolCallId: "untrusted-scope" },
            ),
        ).rejects.toBeInstanceOf(ToolDeniedError);
        await expect(
          installed.kernel
            .get("tools")
            .require(`${CU_TOOL_PREFIX}screenshot`)
            .execute(
              { app: { pid: fixture.pid } },
              { runId, toolCallId: "missing-trusted-task" },
            ),
        ).resolves.toMatchObject({
          isError: true,
          structuredContent: { error: { code: "context_required" } },
        });
      } finally {
        resumeModel();
        if (activeRunId) await task?.runtime.cancelRunAndWait(activeRunId);
        await pumping?.catch(() => {});
        await mcpClient?.close();
        await mcpServer?.close();
        await installed?.kernel.dispose();
        await installed?.app.close();
        await task?.work.close("macOS验收清理");
        await task?.persistence.dispose();
        await modelServer?.close();
        if (fixture && fixture.exitCode === null) {
          fixture.kill();
          await once(fixture, "exit");
        }
        await database.close();
      }
    },
    AGENT_GOVERNANCE_DEFAULTS.computerUseSessionMaxMs,
  );
});
