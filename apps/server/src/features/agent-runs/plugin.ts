import type { BaseLanguageModel } from "@langchain/core/language_models/base";
import type { LoomicAgentFactory } from "../../agent/deep-agent.js";
import { createAgentPersistenceService } from "../../agent/persistence/index.js";
import { createAgentRunService } from "../../agent/runtime.js";
import { registerRunRoutes } from "../../http/runs.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import { createAgentRunMetadataService } from "./agent-run-service.js";

export interface AgentRunsPluginDeps {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  connectionManager: ConnectionManager;
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
    inject: ["auth", "credits", "settings", "threads", "tierGuard", "viewer"],
    apply(ctx) {
      ctx.register("agentPersistence", () =>
        createAgentPersistenceService(ctx.env),
      );
      ctx.register("agentRunMetadata", () =>
        createAgentRunMetadataService({ getAdminClient: deps.getAdminClient }),
      );
      ctx.register("agentRuns", (d) => {
        const jobService = ctx.tryGet("jobs");
        return createAgentRunService({
          agentPersistenceService: d.get("agentPersistence"),
          ...(deps.agentFactory ? { agentFactory: deps.agentFactory } : {}),
          agentRunMetadataService: d.get("agentRunMetadata"),
          connectionManager: deps.connectionManager,
          createUserClient: deps.createUserClient,
          ...(deps.agentModel ? { model: deps.agentModel } : {}),
          ...(deps.mockEventDelayMs === undefined
            ? {}
            : { eventDelayMs: deps.mockEventDelayMs }),
          env: ctx.env,
          ...(jobService ? { jobService } : {}),
          modelProviders: ctx.get("modelProviders"),
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
      });
    },
  };
}
