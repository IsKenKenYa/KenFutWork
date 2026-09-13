import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { LoomicAgentFactory } from "../../agent/deep-agent.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { createWorkspaceSkillsLoader } from "../../agent/workspace-skills.js";
import { registerRunRoutes } from "../../http/runs.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createSkillCatalogRepository } from "../skills/repository.js";
import { createAgentRunMetadataService } from "./agent-run-service.js";
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
  agentFactory?: LoomicAgentFactory;
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
      ctx.register("agentRunMetadata", () =>
        createAgentRunMetadataService({
          repository: createAgentRunRepository(ctx.get("persistence")),
        }),
      );
      const canvasRepository = createCanvasRepository(ctx.get("persistence"));

      ctx.register("agentRuns", (d) => {
        const jobService = ctx.tryGet("jobs");
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
          creditService: d.get("credits"),
          tierGuard: d.get("tierGuard"),
          viewerService: d.get("viewer"),
        });
      });
    },
    mounted(ctx) {
      void registerRunRoutes(ctx.app, ctx.get("agentRuns"), {
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
