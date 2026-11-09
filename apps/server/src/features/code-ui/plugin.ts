import { resolve } from "node:path";
import type { AgentRunExtension } from "../../agent/run-extension.js";
import { resolveDesktopDataDir } from "../../desktop/paths.js";
import { registerCodeUiRoutes } from "../../http/code-ui.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  createGoalPrompt,
  createGoalTools,
  GOAL_TOOL_EVIDENCE_VALIDATOR_CAPABILITY,
  type GoalToolEvidenceValidator,
} from "../goals/consumer.js";
import { startPeriodicScan } from "../jobs/periodic-scan.js";
import {
  createMemorySaveTool,
  createMemorySearchTool,
  createProjectMemoryPromptSection,
} from "../memory/consumer.js";
import { runMemoryMaintenanceScan } from "../memory/maintenance-scan.js";
import {
  createProjectMemoryService,
  type ProjectMemoryService,
} from "../memory/project-memory.js";
import { createProjectMemoryRpc } from "../memory/rpc.js";
import { installNetworkProxy } from "../network/proxy.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import { createApprovedPlanPromptSection } from "./approved-plan-prompt.js";
import { createAskUserQuestionToolDefinition } from "./ask-user-question.js";
import { createCodeAttachmentRepository } from "./attachments/repository.js";
import { createCodeUiClientConfigHost } from "./client-config-host.js";
import { createCodeUiClientScenesHost } from "./client-scenes-host.js";
import { createEnterPlanModeToolDefinition } from "./enter-plan.js";
import { createExitPlanModeToolDefinition } from "./exit-plan.js";
import { createCodeGuideMiddleware } from "./guide-model-mailbox.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
} from "./host-rpc-handler.js";
import { createCodeHistoryOutputPrompt } from "./output-history-prompt.js";
import { createCodeUiProjectGitSessions } from "./project-git-session.js";
import { createCodeUiRepository } from "./repository.js";
import { createCodeUiService } from "./service.js";
import {
  runTaskAutoArchive,
  startTaskAutoArchiveTimer,
} from "./task-auto-archive.js";
import { createUserInputBroker } from "./user-input-broker.js";
import {
  CODE_UI_WORK_CONTEXT_CAPABILITY,
  type ConversationWorkContextProvider,
} from "./work-context.js";

export function createCodeUiPlugin(): PluginDefinition {
  /** apply 期建立的偏好仓储；mounted 的启动期消费者共用同一实例。 */
  let preferenceRepository:
    | ReturnType<typeof createCodeUiRepository>
    | undefined;
  /** apply 期建立的项目记忆服务；mounted 的周期整理共用同一实例。 */
  let projectMemoryService: ProjectMemoryService | undefined;
  return {
    name: "code-ui",
    inject: [
      "goals",
      "localAccess",
      "localInstance",
      "persistence",
      "agentPersistence",
      "projects",
      "canvas",
      "modelProviders",
      "modelCatalog",
      "settings",
      "threads",
      "agentRuns",
      "agentRunMetadata",
      "checkpoints",
      "executionScopes",
      "taskWork",
      "permissions",
      "codeTerminal",
      "blob",
      "processSandbox",
      "plugins",
      "codeGit",
    ],
    apply(ctx) {
      const repository = createCodeUiRepository(
        ctx.get("persistence"),
        ctx.get("goals"),
      );
      preferenceRepository = repository;
      /**
       * 项目长期记忆：开关存实例偏好（`memoryEnabled`），正文存应用数据目录。
       * 三个消费方（设置页目录、系统提示段、写入工具）共用同一份服务，
       * 不另建第二套状态。
       */
      const projectMemory = createProjectMemoryService({
        dataDir: resolveDesktopDataDir({
          env: { KENFUTWORK_DATA_DIR: ctx.env.desktopDataDir },
        }),
        projects: ctx.get("projects"),
        localInstance: ctx.get("localInstance"),
        preferences: repository,
        settings: ctx.get("settings"),
        canvases: ctx.get("canvas"),
        agentPersistence: ctx.get("agentPersistence"),
      });
      projectMemoryService = projectMemory;
      ctx.register("codeUi", () => {
        const userInputs = createUserInputBroker();
        return createCodeUiService({
          captureContributions: (preset) =>
            ctx.get("tools").captureContributions(preset),
          workContextProvider: (preset) =>
            ctx
              .get("capabilities")
              .get<ConversationWorkContextProvider>(
                CODE_UI_WORK_CONTEXT_CAPABILITY,
                preset,
              ),
          goalToolEvidenceValidator: (toolName) =>
            ctx
              .get("capabilities")
              .get<GoalToolEvidenceValidator>(
                GOAL_TOOL_EVIDENCE_VALIDATOR_CAPABILITY,
                toolName,
              ),
          hostRpcHandler: (service, method) =>
            ctx
              .get("capabilities")
              .get<CodeUiHostRpcHandler>(
                CODE_UI_HOST_RPC_CAPABILITY,
                `${service}.${method}`,
              ),
          goals: ctx.get("goals"),
          userInputs,
          repository,
          memory: createProjectMemoryRpc(projectMemory),
          executionScopes: ctx.get("executionScopes"),
          taskWork: ctx.get("taskWork"),
          permissions: ctx.get("permissions"),
          terminals: ctx.get("codeTerminal"),
          processSandbox: ctx.get("processSandbox"),
          projectGitSessions: createCodeUiProjectGitSessions({
            persistence: ctx.get("persistence"),
            sandbox: ctx.get("processSandbox"),
          }),
          // G3/Q8：run 终态自动提交缝（code-git 域内收口开关与失败静默）。
          codeGit: ctx.get("codeGit"),
          plugins: ctx.get("plugins"),
          blob: ctx.get("blob"),
          attachmentRepository: createCodeAttachmentRepository(
            ctx.get("persistence"),
            resolve(ctx.env.checkpointRoot ?? "data/checkpoints"),
          ),
          beforeCloseTask: createTaskResourceCloser({
            localInstance: ctx.get("localInstance"),
            resources: () => ({
              runs: ctx.get("agentRuns"),
              work: ctx.get("taskWork"),
              sandbox: ctx.get("processSandbox"),
              capabilities: ctx.get("capabilities"),
            }),
          }),
          localInstance: ctx.get("localInstance"),
          projects: ctx.get("projects"),
          modelProviders: ctx.get("modelProviders"),
          modelCatalog: ctx.get("modelCatalog"),
          settings: ctx.get("settings"),
          threads: ctx.get("threads"),
          agentRuns: ctx.get("agentRuns"),
          agentRunMetadata: ctx.get("agentRunMetadata"),
          checkpoints: ctx.get("checkpoints"),
          env: ctx.env,
        });
      });
      ctx
        .get("systemPrompt")
        .register(createProjectMemoryPromptSection(projectMemory));
      ctx.get("tools").register(createMemorySaveTool(projectMemory));
      ctx.get("tools").register(createMemorySearchTool(projectMemory));
      ctx.get("systemPrompt").register(
        createGoalPrompt(
          {
            read: (context) => ctx.get("codeUi").taskGoals.read(context),
            verify: (context, input) =>
              ctx.get("codeUi").taskGoals.verify(context, input),
          },
          { scope: "shared" },
        ),
      );
      for (const name of ["GetGoal", "VerifyGoal"])
        ctx.get("tools").registerDynamic({
          id: `code.goal.${name}`,
          scope: "shared",
          resolve(run) {
            if (
              run.scopeHandle?.role !== "main" ||
              run.scopeHandle.agentId !== "main"
            )
              return null;
            return (
              createGoalTools(
                {
                  read: (context) => ctx.get("codeUi").taskGoals.read(context),
                  verify: (context, input) =>
                    ctx.get("codeUi").taskGoals.verify(context, input),
                },
                { scope: "shared" },
              ).find((tool) => tool.name === name) ?? null
            );
          },
        });
      ctx.get("tools").registerDynamic({
        id: "code.planning.enter",
        scope: "shared",
        resolve(run) {
          if (
            run.scopeHandle?.role !== "main" ||
            run.scopeHandle.agentId !== "main"
          )
            return null;
          return createEnterPlanModeToolDefinition({
            control: {
              enter: (context) => ctx.get("codeUi").enterPlanMode(context),
            },
          });
        },
      });
      ctx.get("systemPrompt").register(
        createApprovedPlanPromptSection({
          read: (context) => ctx.get("codeUi").readApprovedPlan(context),
        }),
      );
      ctx.get("systemPrompt").register(
        createCodeHistoryOutputPrompt({
          manifest: (context) =>
            ctx.get("codeUi").outputHistory.manifest(context),
        }),
      );
      ctx.get("tools").registerDynamic({
        id: "code.planning.exit",
        scope: "shared",
        resolve(run) {
          if (
            run.scopeHandle?.role !== "main" ||
            run.scopeHandle.agentId !== "main"
          )
            return null;
          return createExitPlanModeToolDefinition({
            control: {
              exit: (context) => ctx.get("codeUi").exitPlanMode(context),
            },
          });
        },
      });
      ctx.get("tools").registerDynamic({
        id: "code.user-input.ask-user-question",
        scope: "shared",
        resolve(run) {
          if (!run.scopeHandle) return null;
          const broker = ctx.get("codeUi").userInputs;
          if (!broker) throw new Error("Code UI 提问服务未装配");
          return createAskUserQuestionToolDefinition({ broker });
        },
      });
    },
    mounted(ctx) {
      const guideExtension: AgentRunExtension = {
        preset: "shared",
        createMiddleware(identity, context) {
          return createCodeGuideMiddleware(
            ctx.get("codeUi"),
            identity,
            context,
          );
        },
      };
      ctx.get("capabilities").register("agent-run-extension", {
        id: "code-ui:guide",
        value: guideExtension,
      });
      // 客户端场景目录与公开客户端配置都由上游远端提供；
      // 本机宿主登记如实结果（业务未支持 / 空配置），避免 501 触发重复重试。
      for (const [id, value] of Object.entries({
        ...createCodeUiClientScenesHost(),
        ...createCodeUiClientConfigHost(),
      })) {
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register(CODE_UI_HOST_RPC_CAPABILITY, { id, value }),
        );
      }
      ctx.effect(() =>
        ctx.get("settings").onUpdated(({ instanceId, changedKeys }) => {
          if (
            changedKeys.includes("defaultModel") ||
            changedKeys.includes("commands")
          )
            return ctx.get("codeUi").refreshWorkspaceConfiguration(instanceId);
        }),
      );
      const preferencesRepository = preferenceRepository;
      if (!preferencesRepository) throw new Error("Code UI 偏好仓储未装配。");
      const autoArchiveTasks = async () => {
        const actor = await ctx.get("localInstance").serviceActor();
        const preferences = await preferencesRepository.readHumanPreferences(
          actor.instanceId,
        );
        const result = await runTaskAutoArchive({
          preferences: {
            enabled: preferences.taskAutoArchiveEnabled,
            olderThanDays: preferences.taskAutoArchiveOlderThanDays,
          },
          listRoots: () => preferencesRepository.listRoots(actor.instanceId),
          archive: (taskId) => ctx.get("codeUi").archiveTask(actor, taskId),
        });
        if (result.failed.length)
          console.warn(
            "[code-ui] 任务自动归档有未完成的项：",
            result.failed.map((failure) => failure.taskId),
          );
      };
      // 偏好变更不重启也能生效：关闭/调整天数后立刻按新值扫一次。
      ctx.effect(() =>
        ctx.get("codeUi").onPreferencesUpdated((_instanceId, changedKeys) => {
          if (
            changedKeys.includes("taskAutoArchiveEnabled") ||
            changedKeys.includes("taskAutoArchiveOlderThanDays")
          )
            return autoArchiveTasks();
        }),
      );
      // 进程内周期扫描：长时间运行时也能按偏好把新近变旧的 Task 归档。
      // 间隔来自治理设置（设置页可调），变更后重启定时器，不必重启服务。
      let stopAutoArchiveTimer: (() => void) | undefined;
      /** 并发重读设置时只让最后一次生效，卸载后不再起定时器。 */
      let autoArchiveGeneration = 0;
      let autoArchiveClosed = false;
      const restartAutoArchiveTimer = async () => {
        const generation = ++autoArchiveGeneration;
        const actor = await ctx.get("localInstance").serviceActor();
        const settings = await ctx
          .get("settings")
          .getInstanceSettings(actor, actor.instanceId);
        if (autoArchiveClosed || generation !== autoArchiveGeneration) return;
        stopAutoArchiveTimer?.();
        stopAutoArchiveTimer = startTaskAutoArchiveTimer({
          scan: autoArchiveTasks,
          onError: (error) =>
            console.warn("[code-ui] 任务自动归档周期扫描失败：", error),
          intervalMs: settings.taskAutoArchiveScanIntervalMs,
        });
      };
      ctx.effect(() => {
        autoArchiveClosed = false;
        void restartAutoArchiveTimer();
        return () => {
          autoArchiveClosed = true;
          autoArchiveGeneration += 1;
          stopAutoArchiveTimer?.();
        };
      });
      ctx.effect(() =>
        ctx.get("settings").onUpdated(({ changedKeys }) => {
          if (changedKeys.includes("taskAutoArchiveScanIntervalMs"))
            void restartAutoArchiveTimer();
        }),
      );
      const memoryService = projectMemoryService;
      if (!memoryService) throw new Error("项目记忆服务未装配。");
      /** 关闭记忆的实例直接跳过，不为空目录做整理。 */
      const maintainMemories = async () => {
        const actor = await ctx.get("localInstance").serviceActor();
        const result = await runMemoryMaintenanceScan({
          actor,
          isEnabled: (instanceId) => memoryService.isEnabled(instanceId),
          listProjects: (currentActor, kind) =>
            ctx.get("projects").listProjects(currentActor, kind),
          maintain: async (projectId) => {
            await memoryService.maintainProjectMemory(actor, { projectId });
          },
        });
        if (result.failed.length)
          console.warn("[code-ui] 项目记忆整理有未完成的项：", result.failed);
      };
      let stopMemoryTimer: (() => void) | undefined;
      /** 并发重读设置时只让最后一次生效，卸载后不再起定时器。 */
      let memoryGeneration = 0;
      let memoryClosed = false;
      const restartMemoryTimer = async () => {
        const generation = ++memoryGeneration;
        const actor = await ctx.get("localInstance").serviceActor();
        const settings = await ctx
          .get("settings")
          .getInstanceSettings(actor, actor.instanceId);
        if (memoryClosed || generation !== memoryGeneration) return;
        stopMemoryTimer?.();
        stopMemoryTimer = startPeriodicScan({
          scan: maintainMemories,
          onError: (error) =>
            console.warn("[code-ui] 项目记忆整理周期扫描失败：", error),
          intervalMs: settings.memoryMaintenanceIntervalMs,
        });
      };
      ctx.effect(() => {
        memoryClosed = false;
        void restartMemoryTimer();
        return () => {
          memoryClosed = true;
          memoryGeneration += 1;
          stopMemoryTimer?.();
        };
      });
      ctx.effect(() =>
        ctx.get("settings").onUpdated(({ changedKeys }) => {
          if (changedKeys.includes("memoryMaintenanceIntervalMs"))
            void restartMemoryTimer();
        }),
      );
      ctx.app.addHook("onReady", async () => {
        const actor = await ctx.get("localInstance").serviceActor();
        /**
         * 网络出口：代理/No Proxy/自定义 CA 在启动期装配到全局 dispatcher（界面
         * 已提示需重启）。读取偏好失败或 CA 路径非法时启动期报错，不静默忽略。
         */
        await installNetworkProxy({
          preferences: await preferencesRepository.readHumanPreferences(
            actor.instanceId,
          ),
        });
        await ctx.get("codeUi").initialize();
        await autoArchiveTasks();
      });
      const permissions = ctx.get("permissions");
      const userInputs = ctx.get("codeUi").userInputs;
      if (!userInputs) throw new Error("Code UI 提问服务未装配");
      ctx.effect(() =>
        userInputs.onEvent((event) =>
          ctx.get("codeUi").onUserInputEvent(event),
        ),
      );
      ctx.effect(() => () => userInputs.close("Code UI 宿主关闭"));
      ctx.effect(() =>
        permissions.onEvent((event) =>
          ctx.get("codeUi").onApprovalEvent(event),
        ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous }) =>
            permissions.cancel(
              { instanceId: previous.instanceId, taskId: previous.taskId },
              "Task 授权发生变更",
            ),
          ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous }) =>
            userInputs.cancel(
              { instanceId: previous.instanceId, taskId: previous.taskId },
              "Task 授权发生变更",
            ),
          ),
      );
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous }) =>
            ctx
              .get("codeUi")
              .closeTaskWatchers(previous.instanceId, previous.taskId),
          ),
      );
      ctx.effect(() => () => ctx.get("codeUi").closeConnections());
      ctx.get("capabilities").register("task-close", {
        id: "code-ui:file-watchers",
        value: {
          close: (instanceId: string, taskId: string) =>
            ctx.get("codeUi").closeTaskWatchers(instanceId, taskId),
        },
      });
      ctx.get("capabilities").register("task-close", {
        id: "code-ui:user-input",
        value: {
          close: (instanceId: string, taskId: string) =>
            userInputs.cancel({ instanceId, taskId }, "Task 已关闭"),
        },
      });
      ctx.get("capabilities").register("task-close", {
        id: "permissions:code-calls",
        value: {
          close: (instanceId: string, taskId: string) =>
            permissions.cancel({ instanceId, taskId }, "Task 已关闭"),
        },
      });
      void registerCodeUiRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        service: ctx.get("codeUi"),
      });
    },
  };
}
