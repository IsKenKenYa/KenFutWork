import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import type { ChatOpenAI } from "@langchain/openai";
import Fastify from "fastify";
import { createNativeContextBranchService } from "../../../agent/native-context-branch.js";
import { createAgentPersistenceService } from "../../../agent/persistence/index.js";
import type { AgentRunExtension } from "../../../agent/run-extension.js";
import { createAgentRunService } from "../../../agent/runtime.js";
import type { loadServerEnv } from "../../../config/env.js";
import { composePlugins } from "../../../kernel/compose.js";
import type { PluginDefinition } from "../../../kernel/types.js";
import { prepareHarnessTask } from "../../agent-runs/test-harness.js";
import { createLocalFsBlobStore } from "../../blob/providers/local-fs.js";
import { createCodeUiAgentEventsPlugin } from "../../code-ui/agent-events-plugin.js";
import {
  type CodeUiConversationState,
  createCodeUiConversation,
} from "../../code-ui/conversation.js";
import { createScopeRepository } from "../../execution/scope-repository.js";
import { createExecutionScopes } from "../../execution/scope-service.js";
import { createPermissionsPlugin } from "../../permissions/plugin.js";
import { buildBundleManifest } from "../../plugins/bundle-manifest.js";
import { validateBundleFiles } from "../../plugins/compat-validator.js";
import { createPluginRegistryService } from "../../plugins/plugin-registry-service.js";
import { createPluginStorage } from "../../plugins/plugin-storage.js";
import { createSettingsRepository } from "../../settings/repository.js";
import { createSettingsService } from "../../settings/settings-service.js";
import { createTaskWorkStore } from "../../task-work/repository.js";
import { createTaskWorkManager } from "../../task-work/service.js";
import type { createTaskWorkDatabase } from "../../task-work/test-postgres-schema.js";
import { createToolCatalogPlugin } from "../../tool-catalog/plugin.js";
import { createComputerUsePlugin } from "../plugin.js";
import { CU_BUNDLE_ID } from "../tools.js";

type Database = Awaited<ReturnType<typeof createTaskWorkDatabase>>;

export async function installedKernel(
  database: Database,
  env: ReturnType<typeof loadServerEnv>,
  additionalPlugins: readonly PluginDefinition[] = [],
) {
  const root = new URL(
    "../../../../../../plugins/computer-use/",
    import.meta.url,
  );
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
      ...additionalPlugins,
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

export async function taskRuntime(
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
