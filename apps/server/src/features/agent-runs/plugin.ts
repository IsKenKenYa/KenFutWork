import {
  isAutomationExecutionMode,
  zcodeUiProtocol as protocol,
} from "@kenfutwork/shared";
import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type {
  KenFutWorkAgentFactory,
  ToolGate,
} from "../../agent/deep-agent.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import type { AgentRunExtension } from "../../agent/run-extension.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { composeToolGate } from "../../agent/tool-gate.js";
import {
  createWorkspaceSkillsByWorkspaceLoader,
  createWorkspaceSkillsLoader,
} from "../../agent/workspace-skills.js";
import { registerRunRoutes } from "../../http/runs.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import { evaluateToolPolicy } from "../agent-modes/execution-mode-service.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createProjectRepository } from "../projects/repository.js";
import { createProjectWorkDirLoader } from "../projects/work-dir.js";
import { createSkillCatalogRepository } from "../skills/repository.js";
import {
  createAgentActivityQuery,
  createAgentRunMetadataService,
} from "./agent-run-service.js";
import {
  basePromptSection,
  codeProjectPromptSection,
  codeRolePromptSection,
  createRulesPromptSection,
  skillsPromptSection,
} from "./prompt-sections.js";
import { createAgentRunRepository } from "./repository.js";

export interface AgentRunsPluginDeps {
  connectionManager: ConnectionManager;
  /** 内核事件缝：turn 收尾发射 turn-stopping（用量结算挂钩点）。 */
  events: KernelEvents;
  /** 事件缝（DEC-1）：pre-step waterfall，执行模式/权限插件改写模型输入。 */
  emitPreStep?: (payload: {
    input: string;
    runId: string;
    threadId?: string | undefined;
  }) => Promise<{ input: unknown }>;
  agentFactory?: KenFutWorkAgentFactory;
  agentModel?: BaseLanguageModel | string;
  mockEventDelayMs?: number;
}

/** agent-runs 插件：agent 运行时三件套（agentPersistence/agentRunMetadata/agentRuns）+ runs 路由。 */
export function createAgentRunsPlugin(
  deps: AgentRunsPluginDeps,
): PluginDefinition {
  return {
    name: "agent-runs",
    inject: [
      "agentModes",
      "auth",
      "brandKit",
      "canvas",
      "credits",
      "persistence",
      "settings",
      "threads",
      "tierGuard",
      "viewer",
      "taskWork",
    ],
    apply(ctx) {
      ctx.register("agentPersistence", () =>
        createAgentPersistenceService(ctx.env),
      );
      const agentRunRepository = createAgentRunRepository(
        ctx.get("persistence"),
      );
      ctx.register("agentRunMetadata", () =>
        createAgentRunMetadataService({
          repository: agentRunRepository,
          viewerService: ctx.get("viewer"),
          threadService: ctx.get("threads"),
        }),
      );
      const canvasRepository = createCanvasRepository(ctx.get("persistence"));

      // 运行时属主的提示段：base（两模式恒挂）、skills（run 事实渲染）、
      // 规则与插件段（规则经 ctx 携带，插件段闭包自取——装/卸载下一轮即生效）。
      const systemPrompt = ctx.get("systemPrompt");
      systemPrompt.register(basePromptSection);
      systemPrompt.register(codeRolePromptSection);
      systemPrompt.register(codeProjectPromptSection);
      systemPrompt.register(skillsPromptSection);
      systemPrompt.register(
        createRulesPromptSection({
          pluginFragments: () =>
            ctx.tryGet("plugins")?.listPromptFragments() ?? [],
        }),
      );

      ctx.register("agentRuns", (d) => {
        const jobService = ctx.tryGet("jobs");
        // 检查点缝（可选依赖）：有 checkpoints 服务时把轮次快照钩子接进 runtime；
        // 缺席（部分装配/未启用）则不打检查点，run 照常
        const checkpoints = ctx.tryGet("checkpoints");
        // 执行模式工具门：solo/plan 策略归 agent-modes，运行时只拿到判定函数
        const agentModes = d.get("agentModes");
        // 权限档同门：内置工具（execute/write_file/edit_file）不经过 ctx.tools.execute，
        // tool-pre-execute 事件缝拦不到它们，必须在这里与模式判定合并（见 tool-gate.ts）。
        const permissions = ctx.tryGet("permissions");
        const toolGateFor = (threadId: string): ToolGate => {
          const policy = agentModes.resolveToolPolicy(threadId);
          // 分场景（R5-3）：目标/循环这类无人值守轮次走「自动化任务」那一档
          const scenario = isAutomationExecutionMode(
            agentModes.getMode(threadId),
          )
            ? ("automation" as const)
            : ("interactive" as const);
          return composeToolGate({
            modeVerdict: (toolName, detail) =>
              evaluateToolPolicy(policy, toolName, detail),
            ...(permissions
              ? {
                  permissionVerdict: (toolName: string) => {
                    const decision = permissions.evaluate({
                      toolName,
                      threadId,
                      scenario,
                    });
                    if (decision.decision !== "deny") {
                      return { allowed: true } as const;
                    }
                    return {
                      allowed: false as const,
                      reason:
                        decision.reason ??
                        "该工具在当前权限档位下需审批后才能调用。",
                    };
                  },
                }
              : {}),
          });
        };
        return createAgentRunService({
          codeProjectContextLoader: (scope, limits, signal) =>
            ctx
              .get("capabilities")
              .require<
                NonNullable<
                  Parameters<
                    typeof createAgentRunService
                  >[0]["codeProjectContextLoader"]
                >
              >("code-project-context", "code-tools:project-context")(
              scope,
              limits,
              signal,
            ),
          resolveCodeApprovalMode: async (handle) => {
            const scope = handle.describe();
            const row = await ctx
              .get("persistence")
              .forWorkspace(scope.workspaceId)
              .queryOne<{
                state: import("../code-ui/conversation.js").CodeUiConversationState;
                scope_generation: number | string;
                branch_generation: number | string;
              }>(
                "select state, scope_generation, branch_generation from public.code_ui_sessions where workspace_id = :workspace and id = $1 and parent_session_id is null and deleted_at is null and archived = false and execution_state = 'ready'",
                [scope.taskId],
              );
            if (!row) throw new Error("Code Task 已关闭或授权不可用。");
            const config = row.state.snapshots.find(
              (snapshot) => snapshot.sessionId === scope.taskId,
            )?.config;
            if (!config) throw new Error("Code Task 权限配置缺失。");
            return {
              mode: protocol.commandPayloadSchemas.switchCollaborationMode.parse(
                { mode: config.mode },
              ).mode,
              scopeGeneration: Number(row.scope_generation),
              branchGeneration: Number(row.branch_generation),
            };
          },
          taskWork: ctx.get("taskWork"),
          processSandbox: ctx.get("processSandbox"),
          resolveTaskWorkContext: async (actor, scopeHandle, runId) => {
            const scope = scopeHandle.describe();
            const row = await ctx
              .get("persistence")
              .forWorkspace(scope.workspaceId)
              .queryOne<{ branch_generation: string | number }>(
                "select branch_generation from public.code_ui_sessions where workspace_id = :workspace and id = $1 and deleted_at is null and archived = false and execution_state = 'ready'",
                [scope.taskId],
              );
            if (!row) throw new Error("Code Task 已关闭或授权不可用。");
            return {
              actor,
              scope,
              agentId: scopeHandle.agentId,
              runId,
              branchGeneration: Number(row.branch_generation),
            };
          },
          runExtensions: () =>
            ctx
              .get("capabilities")
              .list<AgentRunExtension>("agent-run-extension")
              .map((registration) => registration.value),
          agentPersistenceService: d.get("agentPersistence"),
          ...(deps.agentFactory ? { agentFactory: deps.agentFactory } : {}),
          agentRunMetadataService: d.get("agentRunMetadata"),
          canvasRepository,
          canvasService: d.get("canvas"),
          // 保留本次实际有效文件引用，runtime分别记录capture状态与run/phase。
          ...(checkpoints
            ? {
                checkpointHooks: {
                  beforeTurn: (hookCtx) => checkpoints.captureTurnBoundary({ ...hookCtx, phase: "pre" }),
                  afterTurn: (hookCtx) => checkpoints.captureTurnBoundary({ ...hookCtx, phase: "post" }),
                },
              }
            : {}),
          workspaceSkillsLoader: createWorkspaceSkillsLoader({
            canvases: canvasRepository,
            skills: createSkillCatalogRepository(ctx.get("persistence")),
          }),
          workspaceSkillsByWorkspaceLoader:
            createWorkspaceSkillsByWorkspaceLoader({
              skills: createSkillCatalogRepository(ctx.get("persistence")),
            }),
          // 项目绑定的本机工作目录（web 形态「填本机路径」）→ run 的沙箱作用域
          projectWorkDirLoader: createProjectWorkDirLoader({
            canvases: canvasRepository,
            projects: createProjectRepository(ctx.get("persistence")),
          }),
          connectionManager: deps.connectionManager,
          ...(deps.agentModel ? { model: deps.agentModel } : {}),
          ...(deps.mockEventDelayMs === undefined
            ? {}
            : { eventDelayMs: deps.mockEventDelayMs }),
          blob: ctx.get("blob"),
          env: ctx.env,
          ...(jobService ? { jobService } : {}),
          modelProviders: ctx.get("modelProviders"),
          // run 起始期校验模型是否在目录里（E）：可选用依赖，没有就跳过
          ...(ctx.tryGet("modelCatalog")
            ? { modelCatalog: ctx.get("modelCatalog") as never }
            : {}),
          // 用户规则（settings 同一趟顺带读 autoCompact/hooks）：规则段经
          // systemPromptRegistry 组装，runtime 只负责把读到的片段放进 ctx
          settingsService: ctx.get("settings"),
          runUsage: ctx.get("runUsage"),
          tools: ctx.get("tools"),
          systemPromptRegistry: ctx.get("systemPrompt"),
          emitTurnStopping: (payload) => deps.events.emitTurnStopping(payload),
          ...(deps.emitPreStep ? { emitPreStep: deps.emitPreStep } : {}),
          toolGateFor,
          creditService: d.get("credits"),
          tierGuard: d.get("tierGuard"),
          viewerService: d.get("viewer"),
        });
      });
    },
    mounted(ctx) {
      void registerRunRoutes(ctx.app, ctx.get("agentRuns"), {
        // 活动查询：mounted 与 apply 是两段作用域，这里按需新建一个仓储包装
        // （仓储是无状态包装，重建不引入额外连接/状态）
        activityQuery: createAgentActivityQuery({
          repository: createAgentRunRepository(ctx.get("persistence")),
        }),
        agentModes: ctx.get("agentModes"),
        executionScopes: ctx.get("executionScopes"),
        codeUi: ctx.get("codeUi"),
        agentRunMetadataService: ctx.get("agentRunMetadata"),
        auth: ctx.get("auth"),
        settingsService: ctx.get("settings"),
        threadService: ctx.get("threads"),
        viewerService: ctx.get("viewer"),
        // 平台池额度前置拦截（FORM-10）：走系统供应商且余额耗尽时拒绝启动
        creditService: ctx.get("credits"),
        modelProviders: ctx.get("modelProviders"),
      });
    },
  };
}
