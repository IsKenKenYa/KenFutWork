import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceSettingsSchema } from "@kenfutwork/shared";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { loadServerEnv } from "../../config/env.js";
import { createViewerService } from "../bootstrap/ensure-user-foundation.js";
import { createViewerRepository } from "../bootstrap/repository.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createCheckpointService } from "../checkpoints/checkpoint-service.js";
import { createCheckpointRepository } from "../checkpoints/repository.js";
import {
  createShadowGitClient,
  type ExecShadowGit,
} from "../checkpoints/shadow-git-client.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { acquireTaskFileRestoreBarrier } from "../execution/scoped-filesystem.js";
import { createTaskWorkManager } from "../task-work/service.js";
import type { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMemoryTaskWorkStore } from "../task-work/test-store.js";
import type { TaskWorkContext } from "../task-work/types.js";
import { createAgentRunMetadataService } from "./agent-run-service.js";
import { createAgentRunRepository } from "./repository.js";

export async function prepareHarnessTask(
  database: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
) {
  const scope = database.context.scope;
  const owner = await database.persistence.queryOne<{
    owner_user_id: string;
  }>("select owner_user_id from public.workspaces where id=$1", [
    scope.workspaceId,
  ]);
  if (!owner) throw new Error("私有工作区不存在");
  const actor = {
    id: owner.owner_user_id,
    email: "boundary@integration.test",
    accessToken: "private",
    userMetadata: {},
  };
  const threadId = `boundary-thread-${randomUUID()}`;
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
  const metadata = () =>
    createAgentRunMetadataService({
      repository: createAgentRunRepository(database.persistence),
      viewerService: viewer,
      threadService: threads,
    });
  return { scope, actor, threadId, viewer, threads, metadata };
}

export class BoundaryModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  constructor(
    private readonly beforeReply?: (signal?: AbortSignal) => Promise<void>,
  ) {
    super({});
  }
  _llmType() {
    return "boundary-model";
  }
  bindTools(): this {
    return this;
  }
  async _generate(messages: BaseMessage[], options?: { signal?: AbortSignal }) {
    this.requests.push(messages);
    await this.beforeReply?.(options?.signal);
    return { generations: [{ text: "完成", message: new AIMessage("完成") }] };
  }
}

export async function createHarness(
  database: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
  controlledModel?: BoundaryModel,
  checkpointHooks?: Parameters<
    typeof createAgentRunService
  >[0]["checkpointHooks"],
  singleAttempt = false,
  runtimeOptions?: Pick<
    Parameters<typeof createAgentRunService>[0],
    "agentFactory" | "settingsService" | "agentPersistenceService"
  >,
) {
  const { scope, actor, threadId, viewer, threads, metadata } =
    await prepareHarnessTask(database);
  const executionScopes = createExecutionScopes({
    repository: createScopeRepository(database.persistence),
    viewerService: viewer,
  });
  const handle = await executionScopes.openTask(actor, scope.taskId);
  const context: TaskWorkContext = {
    ...database.context,
    actor,
    agentId: handle.agentId,
  };
  const work = createTaskWorkManager({
    store: createMemoryTaskWorkStore([context]),
    executionHostId: database.directory,
    resolveMaxConcurrent: async () => 4,
  });
  const model = controlledModel ?? new BoundaryModel();
  const service = metadata();
  const persistence = createAgentPersistenceService({});
  const env = loadServerEnv({
    agentBackendMode: "filesystem",
    agentFilesRoot: database.directory,
  });
  const runtime = createAgentRunService({
    blob: {} as never,
    env,
    model,
    agentPersistenceService: persistence,
    agentRunMetadataService: service,
    ...(checkpointHooks ? { checkpointHooks } : {}),
    ...(singleAttempt
      ? {
          settingsService: {
            getWorkspaceSettings: async () =>
              workspaceSettingsSchema.parse({ llmRequestMaxRetries: 1 }),
          },
        }
      : {}),
    ...runtimeOptions,
    taskWork: work,
    resolveTaskWorkContext: async (_actor, current, runId) => ({
      ...context,
      scope: current.describe(),
      runId,
    }),
    resolveCodeApprovalMode: async () => ({
      mode: "build",
      scopeGeneration: scope.generation,
      branchGeneration: 1,
    }),
  });
  return {
    scope,
    actor,
    threadId,
    metadata,
    persistence,
    env,
    handle,
    viewer,
    threads,
    executionScopes,
    model,
    service,
    runtime,
    work,
  };
}

/** Git存储语义的真实进程边界；不把它声明成ProcessSandbox enforcement证据。 */
const executeGit: ExecShadowGit = async (args, directory, input) => {
  try {
    return {
      code: 0,
      stderr: "",
      stdout: execFileSync("git", ["--no-optional-locks", ...args], {
        cwd: directory.workTree,
        env: {
          ...process.env,
          GIT_DIR: directory.gitDir,
          GIT_WORK_TREE: directory.workTree,
        },
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failed = error as { status?: number; stderr?: Buffer };
    return {
      code: failed.status ?? 1,
      stdout: "",
      stderr: failed.stderr?.toString() ?? "Git失败",
    };
  }
};

export function createSnapshots(
  database: Awaited<ReturnType<typeof createTaskWorkDatabase>>,
) {
  const git = createShadowGitClient({
    exec: executeGit,
    writeTextFile: (path, text) => writeFile(path, text, "utf8"),
  });
  return createCheckpointService({
    repository: createCheckpointRepository(database.persistence),
    gitForScope: async () => git,
    gitSource: "system",
    checkpointRoot: join(database.directory, "private-checkpoints"),
    files: {
      observe: (scope, path) => scope.backend.observeBinary(path),
      commit: async (scope, entries, beforeCommit) => {
        const result = await scope.backend.commitBatch(entries, beforeCommit);
        if (!result.complete || !result.newScope)
          throw new Error("私有快照fixture文件提交未完成");
        return result.newScope;
      },
    },
    acquireRestoreBarrier: acquireTaskFileRestoreBarrier,
    onBeforeRestore: async () => {
      throw new Error("本fixture只验证捕获，不允许恢复");
    },
    onAfterRestore: async () => {},
  });
}
