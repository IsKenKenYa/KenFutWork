import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { KenFutWorkAgentFactory, ToolGate } from "../../agent/deep-agent.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { composeToolGate } from "../../agent/tool-gate.js";
import { createWorkspaceSkillsLoader } from "../../agent/workspace-skills.js";
import { registerRunRoutes } from "../../http/runs.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import { evaluateToolPolicy } from "../agent-modes/execution-mode-service.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createSkillCatalogRepository } from "../skills/repository.js";
import {
  createAgentActivityQuery,
  createAgentRunMetadataService,
} from "./agent-run-service.js";
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
    ],
    apply(ctx) {
      ctx.register("agentPersistence", () =>
        createAgentPersistenceService(ctx.env),
      );
      const agentRunRepository = createAgentRunRepository(
        ctx.get("persistence"),
      );
      ctx.register("agentRunMetadata", () =>
        createAgentRunMetadataService({ repository: agentRunRepository }),
      );
      const canvasRepository = createCanvasRepository(ctx.get("persistence"));

      ctx.register("agentRuns", (d) => {
        const jobService = ctx.tryGet("jobs");
        // 执行模式工具门：solo/plan 策略归 agent-modes，运行时只拿到判定函数
        const agentModes = d.get("agentModes");
        // 权限档同门：内置工具（execute/write_file/edit_file）不经过 ctx.tools.execute，
        // tool-pre-execute 事件缝拦不到它们，必须在这里与模式判定合并（见 tool-gate.ts）。
        const permissions = ctx.tryGet("permissions");
        const toolGateFor = (threadId: string): ToolGate => {
          const policy = agentModes.resolveToolPolicy(threadId);
          return composeToolGate({
            modeVerdict: (toolName) => evaluateToolPolicy(policy, toolName),
            ...(permissions
              ? {
                  permissionVerdict: (toolName: string) => {
                    const decision = permissions.evaluate({
                      toolName,
                      threadId,
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
          agentPersistenceService: d.get("agentPersistence"),
          ...(deps.agentFactory ? { agentFactory: deps.agentFactory } : {}),
          agentRunMetadataService: d.get("agentRunMetadata"),
          brandKitService: d.get("brandKit"),
          canvasRepository,
          canvasService: d.get("canvas"),
          workspaceSkillsLoader: createWorkspaceSkillsLoader({
            canvases: canvasRepository,
            skills: createSkillCatalogRepository(ctx.get("persistence")),
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
          runUsage: ctx.get("runUsage"),
          tools: ctx.get("tools"),
          emitTurnStopping: (payload) => deps.events.emitTurnStopping(payload),
          ...(deps.emitPreStep ? { emitPreStep: deps.emitPreStep } : {}),
          toolGateFor,
          // 插件提示段（能力 systemPrompt）：plugins 是可选依赖（部分装配/测试里没有）
          pluginPromptFragments: () =>
            ctx.tryGet("plugins")?.listPromptFragments() ?? [],
          creditService: d.get("credits"),
          tierGuard: d.get("tierGuard"),
          viewerService: d.get("viewer"),
        });
      });
    },
    mounted(ctx) {
      // chat 是可选依赖：缺席时（部分装配/测试）路由照常，只是不做 Code 会话供给
      const chatService = ctx.tryGet("chat");
      void registerRunRoutes(ctx.app, ctx.get("agentRuns"), {
        // 活动查询：mounted 与 apply 是两段作用域，这里按需新建一个仓储包装
        // （仓储是无状态包装，重建不引入额外连接/状态）
        activityQuery: createAgentActivityQuery({
          repository: createAgentRunRepository(ctx.get("persistence")),
        }),
        agentModes: ctx.get("agentModes"),
        agentRunMetadataService: ctx.get("agentRunMetadata"),
        auth: ctx.get("auth"),
        ...(chatService ? { chatService } : {}),
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
