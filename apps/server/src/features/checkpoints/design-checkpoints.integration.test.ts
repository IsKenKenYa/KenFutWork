import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createKenFutWorkDeepAgent } from "../../agent/deep-agent.js";
import { createNativeContextBranchService } from "../../agent/native-context-branch.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { loadServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import { createExecutionModeService } from "../agent-modes/execution-mode-service.js";
import { createAgentRunMetadataService } from "../agent-runs/agent-run-service.js";
import { createAgentRunRepository } from "../agent-runs/repository.js";
import { BoundaryModel } from "../agent-runs/test-harness.js";
import { createChatRepository } from "../chat/repository.js";
import { createThreadService } from "../chat/thread-service.js";
import { createContextHistoryPlugin } from "../context-history/plugin.js";
import { createTestDesignModelSelection } from "../execution/design-goals-test-fixture.js";
import { createDesignRunHost } from "../execution/design-run-host.js";
import { createDesignHostRepository } from "../execution/design-run-host-repository.js";
import { createDesignTasksService } from "../execution/design-tasks.js";
import { createScopeRepository } from "../execution/scope-repository.js";
import { createExecutionScopes } from "../execution/scope-service.js";
import { acquireTaskFileRestoreBarrier } from "../execution/scoped-filesystem.js";
import type { ModelProviderService } from "../model-providers/model-provider-service.js";
import { createProjectRepository } from "../projects/repository.js";
import { createSettingsRepository } from "../settings/repository.js";
import { createSettingsService } from "../settings/settings-service.js";
import { createTaskWorkManager } from "../task-work/service.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createMemoryTaskWorkStore } from "../task-work/test-store.js";
import type { CheckpointService } from "./checkpoint-service.js";
import { createCheckpointService } from "./checkpoint-service.js";
import { createDesignLayoutFiles } from "./design-layout-files.js";
import { createDesignTaskRestore } from "./design-task-restore.js";
import { createCheckpointRepository } from "./repository.js";
import {
  createShadowGitClient,
  type ExecShadowGit,
} from "./shadow-git-client.js";

const executeGit: ExecShadowGit = async (args, scope, input) => {
  try {
    return {
      code: 0,
      stderr: "",
      stdout: execFileSync("git", ["--no-optional-locks", ...args], {
        cwd: scope.workTree,
        env: {
          ...process.env,
          GIT_DIR: scope.gitDir,
          GIT_WORK_TREE: scope.workTree,
        },
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    return {
      code: failure.status ?? 1,
      stderr: failure.stderr?.toString() ?? "Git failed",
      stdout: "",
    };
  }
};

describe.skipIf(process.env.KENFUTWORK_DESIGN_TASK_TEST_PG !== "1")(
  "Design真实Task检查点/轮次边界",
  () => {
    it("runtime边界写入PG；恢复Canvas布局与二进制文件时冻结旧Run并保持用户Git不变", async () => {
      const db = await createTaskWorkDatabase();
      let host: ReturnType<typeof createDesignRunHost> | undefined;
      let contextKernel: ReturnType<typeof composePlugins> | undefined;
      let taskWork: ReturnType<typeof createTaskWorkManager> | undefined;
      let agentPersistence:
        | ReturnType<typeof createAgentPersistenceService>
        | undefined;
      let tasks: ReturnType<typeof createDesignTasksService> | undefined;
      try {
        const designTasks = createDesignTasksService({
          persistence: db.persistence,
          localInstance: db.localInstance,
          sandboxRoot: db.directory,
        });
        tasks = designTasks;
        const chat = createChatRepository(db.persistence);
        const threadService = createThreadService({
          repository: chat,
          localInstance: db.localInstance,
        });
        const metadata = createAgentRunMetadataService({
          repository: createAgentRunRepository(db.persistence),
          localInstance: db.localInstance,
          threadService,
        });
        const { project, canvas } = await createProjectRepository(
          db.persistence,
        ).createProject({
          instanceId: db.instanceId,
          createdByClientId: db.actor.accessClientId,
          kind: "design",
          name: "Design Checkpoints",
          slug: `design-checkpoints-${randomUUID()}`,
          description: null,
          canvasName: "Canvas",
          workDir: db.context.scope.rootDirectory,
        });
        if (!canvas) throw new Error("Design项目未创建Canvas");
        const preparation = await designTasks.prepareCreation(
          db.actor,
          canvas.id,
        );
        if (!preparation) throw new Error("Design Task执行准备缺失");
        const task = await chat.createSession(db.instanceId, {
          canvasId: canvas.id,
          threadId: randomUUID(),
          createdByClientId: db.actor.accessClientId,
          designTaskPreparation: preparation,
        });
        if (!task) throw new Error("Design Task创建失败");
        const executionScopes = createExecutionScopes({
          repository: createScopeRepository(db.persistence),
          localInstance: db.localInstance,
        });
        const scope = await executionScopes.openTask(db.actor, task.id);
        expect(scope.preset).toBe("design");
        const identity = scope.describe();
        const layoutPath = join(
          identity.rootDirectory,
          ".kenfutwork",
          "canvases",
          `${canvas.id}.json`,
        );
        const binaryPath = join(identity.rootDirectory, "media.bin");
        await mkdir(join(identity.rootDirectory, ".kenfutwork", "canvases"), {
          recursive: true,
        });
        const originalLayout = Buffer.from('{"elements":[{"id":"before"}]}\n');
        const originalBinary = Buffer.from([0, 255, 12, 64, 0, 128]);
        await writeFile(layoutPath, originalLayout);
        await writeFile(binaryPath, originalBinary);

        execFileSync("git", ["init", "-q"], { cwd: identity.rootDirectory });
        execFileSync("git", ["config", "user.name", "Integration"], {
          cwd: identity.rootDirectory,
        });
        execFileSync(
          "git",
          ["config", "user.email", "integration@example.test"],
          {
            cwd: identity.rootDirectory,
          },
        );
        await writeFile(
          join(identity.rootDirectory, ".gitignore"),
          ".kenfutwork/\n",
        );
        execFileSync("git", ["add", ".gitignore", "media.bin"], {
          cwd: identity.rootDirectory,
        });
        execFileSync("git", ["commit", "-qm", "user baseline"], {
          cwd: identity.rootDirectory,
        });
        const userHead = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: identity.rootDirectory,
          encoding: "utf8",
        }).trim();

        const git = createShadowGitClient({
          exec: executeGit,
          writeTextFile: async (path, text) => writeFile(path, text, "utf8"),
        });
        const checkpointRoot = join(db.directory, "private-checkpoints");
        const taskContext = {
          actor: db.actor,
          scope: identity,
          ownerKind: "design" as const,
          agentId: "main",
          runId: "setup",
          branchGeneration: scope.branchGeneration,
        };
        taskWork = createTaskWorkManager({
          store: createMemoryTaskWorkStore([taskContext]),
          executionHostId: db.directory,
          resolveMaxConcurrent: async () => 2,
        });
        await taskWork.initialize();
        let snapshots!: CheckpointService;

        const modelSelection = createTestDesignModelSelection();
        const frozenModel = await modelSelection.capture();
        const modelProviders: Pick<ModelProviderService, "resolveCredentials"> =
          {
            resolveCredentials: async (actor, providerId) => {
              if (
                actor.instanceId !== db.instanceId ||
                providerId !== frozenModel.providerId
              )
                throw new Error("检查点fixture模型归属不匹配");
              return {
                instanceId: frozenModel.providerId,
                name: "checkpoint fixture",
                protocol: "openai-compatible",
                apiKey: "fixture",
                baseUrl: "http://127.0.0.1:1/v1",
                configRevision: frozenModel.configRevision,
                models: [
                  {
                    id: frozenModel.modelId,
                    name: "checkpoint fixture",
                    capability: "chat",
                    enabled: true,
                  },
                ],
              };
            },
          };
        const hostDependencies = {
          designGoals: {
            initialize: async () => {},
            readTask: async () => null,
            observe: async () => ({ stop: false }),
            continuation: async () => null,
            onLost: () => () => {},
          },
          agentModes: createExecutionModeService(),
          repository: createDesignHostRepository(db.persistence),
          designTasks,
          metadata,
          threads: threadService,
          executionScopes,
          localInstance: db.localInstance,
          localAccess: db.localAccess,
          taskWork,
        };
        const model = new BoundaryModel();
        agentPersistence = createAgentPersistenceService({});
        const env = loadServerEnv({
          agentBackendMode: "filesystem",
          agentFilesRoot: db.directory,
        });
        const settings = createSettingsService({
          repository: createSettingsRepository(db.persistence),
          localInstance: db.localInstance,
          defaultModel: `${frozenModel.providerId}:${frozenModel.modelId}`,
          ...(env.agentGovernance
            ? { governanceEnv: env.agentGovernance }
            : {}),
        });
        contextKernel = composePlugins(env, [createContextHistoryPlugin()], {
          overrides: { settings },
        });
        const runtime = createAgentRunService({
          tools: contextKernel.get("tools"),
          contextHistoryArchives: contextKernel.get("contextHistoryArchives"),
          blob: {} as never,
          localInstance: db.localInstance,
          settingsService: settings,
          env,
          model,
          modelProviders,
          modelCatalog: {
            validateSpecifier: async (_actor, specifier) =>
              specifier === `${frozenModel.providerId}:${frozenModel.modelId}`
                ? { ok: true }
                : { ok: false, message: "检查点fixture模型选择不匹配" },
            listCatalog: async () => [],
          },
          agentFactory: (options) => {
            const context = options.extensionContext;
            const nativeControl = context?.modelControl;
            if (!context || !nativeControl)
              throw new Error("真实模型配置验证入口缺失");
            return createKenFutWorkDeepAgent({
              ...options,
              model,
              extensionContext: {
                ...context,
                modelControl: {
                  selectInvocation: (snapshot) =>
                    nativeControl.selectInvocation(snapshot),
                  async resolveCurrent() {
                    const resolved = await nativeControl.resolveCurrent();
                    if (!resolved.metadata)
                      throw new Error("模型归属元信息缺失");
                    model.metadata = resolved.metadata;
                    return model;
                  },
                },
              },
            });
          },
          agentPersistenceService: agentPersistence,
          contextBranchProvider: createNativeContextBranchService({
            agentPersistenceService: agentPersistence,
          }),
          agentRunMetadataService: metadata,
          taskWork,
          resolveTaskWorkContext: async (actor, handle, runId) => ({
            actor,
            scope: handle.describe(),
            ownerKind: "design",
            agentId: handle.agentId,
            runId,
            branchGeneration: handle.branchGeneration,
          }),
          resolveCodeApprovalMode: async (_handle, actor) => {
            const policy = await designTasks.readPolicy(actor, task.id);
            return {
              mode: policy.mode,
              planEnabled: policy.planEnabled,
              planningEpoch: policy.planningEpoch,
              scopeGeneration: policy.scopeGeneration,
              branchGeneration: policy.branchGeneration,
            };
          },
          checkpointHooks: {
            beforeTurn: (input) =>
              snapshots.captureTurnBoundary({ ...input, phase: "pre" }),
            afterTurn: (input) =>
              snapshots.captureTurnBoundary({ ...input, phase: "post" }),
          },
        });
        const activeHost = createDesignRunHost({
          modelSelection,
          ...hostDependencies,
          agentRuns: runtime,
        });
        host = activeHost;
        let duringRestore: (() => Promise<void>) | undefined;
        snapshots = createCheckpointService({
          repository: createCheckpointRepository(db.persistence),
          gitForScope: async () => git,
          gitSource: "system",
          checkpointRoot,
          forceIncludePaths: async (handle, actor, root) =>
            root === handle.describe().rootDirectory
              ? createDesignLayoutFiles(db.persistence)(handle, actor)
              : [],
          files: {
            observe: (handle, path) => handle.backend.observeBinary(path),
            commit: async (handle, entries, beforeCommit) => {
              const result = await handle.backend.commitBatch(
                entries,
                async () => {
                  const restoring = await beforeCommit();
                  await duringRestore?.();
                  return restoring;
                },
              );
              if (!result.complete || !result.newScope)
                throw new Error("Design文件恢复未完整提交");
              return result.newScope;
            },
          },
          acquireRestoreBarrier: acquireTaskFileRestoreBarrier,
          onBeforeRestore: async () => {
            throw new Error("Code Task恢复路径不应被Design调用");
          },
          onAfterRestore: async () => {},
          designRestore: createDesignTaskRestore({
            host: activeHost,
            executionScopes,
          }),
        });
        await activeHost.initialize();
        const run = await activeHost.submit(db.actor, {
          taskId: task.id,
          inputId: randomUUID(),
          scopeGeneration: identity.generation,
          branchGeneration: scope.branchGeneration,
          request: {
            sessionId: task.id,
            taskId: task.id,
            projectId: project.id,
            conversationId: randomUUID(),
            prompt: "请整理画布",
            preset: "design",
          },
        });
        await vi.waitFor(
          async () =>
            expect(
              (await designTasks.readPolicy(db.actor, task.id)).activeRunId,
            ).toBeNull(),
          { timeout: 15_000 },
        );
        expect(model.requests.length).toBeGreaterThan(0);
        const boundaries = await metadata.getOwnedTurnBoundaries(db.actor, {
          taskId: task.id,
          runId: run.runId,
        });
        expect(boundaries.pre).toMatchObject({
          taskKind: "design",
          scopeGeneration: identity.generation,
          branchGeneration: scope.branchGeneration,
          files: { status: "captured", reference: expect.any(String) },
        });
        expect(boundaries.post).toMatchObject({
          taskKind: "design",
          files: { status: "captured", reference: expect.any(String) },
        });
        const preCheckpointId =
          boundaries.pre?.files.status === "captured"
            ? boundaries.pre.files.reference
            : null;
        if (!preCheckpointId)
          throw new Error("Design runtime 未持久化 pre 检查点");
        const beforeBytes = Buffer.from([9, 8, 7, 6]);
        const changedLayout = Buffer.from('{"elements":[{"id":"after"}]}\n');
        await writeFile(layoutPath, changedLayout);
        await writeFile(binaryPath, beforeBytes);
        const userIndexBefore = createHash("sha256")
          .update(await readFile(join(identity.rootDirectory, ".git", "index")))
          .digest("hex");
        const userStatusBefore = execFileSync(
          "git",
          ["status", "--porcelain"],
          {
            cwd: identity.rootDirectory,
            encoding: "utf8",
          },
        );
        expect(userStatusBefore).toContain("M media.bin");
        const preview = await snapshots.previewRestore({
          scope,
          actor: db.actor,
          checkpointId: preCheckpointId,
        });
        expect(preview.files.map((file) => file.path).sort()).toEqual(
          [`.kenfutwork/canvases/${canvas.id}.json`, "media.bin"].sort(),
        );

        const originalBoundary = boundaries.pre;
        if (!originalBoundary) throw new Error("缺少真实 pre boundary");
        duringRestore = async () => {
          await expect(
            scope.backend.writeFile({
              path: join(identity.rootDirectory, "late-write.txt"),
              content: "late",
            }),
          ).rejects.toThrow();
          await expect(
            activeHost.submit(db.actor, {
              taskId: task.id,
              inputId: randomUUID(),
              scopeGeneration: identity.generation,
              branchGeneration: scope.branchGeneration,
              request: {
                sessionId: task.id,
                taskId: task.id,
                projectId: project.id,
                conversationId: randomUUID(),
                prompt: "迟到的新Run",
                preset: "design",
              },
            }),
          ).rejects.toThrow();
          await expect(
            metadata.recordTurnBoundary(originalBoundary),
          ).rejects.toMatchObject({
            code: "turn_boundary_conflict",
          });
        };
        await snapshots.restore({
          scope,
          actor: db.actor,
          checkpointId: preCheckpointId,
          expectedVersion: preview.expectedVersion,
        });
        duringRestore = undefined;

        expect(await readFile(layoutPath)).toEqual(originalLayout);
        expect(await readFile(binaryPath)).toEqual(originalBinary);
        expect(
          execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: identity.rootDirectory,
            encoding: "utf8",
          }).trim(),
        ).toBe(userHead);
        expect(
          createHash("sha256")
            .update(
              await readFile(join(identity.rootDirectory, ".git", "index")),
            )
            .digest("hex"),
        ).toBe(userIndexBefore);
        const ready = await designTasks.readPolicy(db.actor, task.id);
        expect([
          ready.executionState,
          ready.scopeGeneration,
          ready.branchGeneration,
        ]).toEqual([
          "ready",
          identity.generation + 1,
          scope.branchGeneration + 1,
        ]);
        expect(
          await readFile(join(identity.rootDirectory, "late-write.txt")).catch(
            () => null,
          ),
        ).toBeNull();
      } finally {
        await host?.close();
        await taskWork?.close("Design checkpoint integration cleanup");
        await tasks?.close();
        await agentPersistence?.dispose();
        await contextKernel?.dispose();
        await db.close();
      }
    });
  },
);
