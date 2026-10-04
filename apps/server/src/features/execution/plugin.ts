import { registerExecutionScopeRoutes } from "../../http/execution-scopes.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { executionScopePromptSection } from "./prompt.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";
import { revokeTaskFileOperations } from "./scoped-filesystem.js";

export function createExecutionScopesPlugin(): PluginDefinition {
  return {
    name: "execution-scopes",
    inject: ["auth", "persistence", "viewer", "settings"],
    apply(ctx) {
      ctx.get("systemPrompt").register(executionScopePromptSection);
      ctx.register("executionScopes", () =>
        createExecutionScopes({
          repository: createScopeRepository(ctx.get("persistence")),
          viewerService: ctx.get("viewer"),
          resolveFileLimits: async (actor, scope) => {
            const settings = await ctx
              .get("settings")
              .getWorkspaceSettings(actor, scope.workspaceId);
            return {
              codeReadMaxBytes: settings.codeReadMaxBytes,
              codeReadPageCharacters: settings.codeReadPageCharacters,
              codeSearchMaxResults: settings.codeSearchMaxResults,
              codeSearchMaxBytes: settings.codeSearchMaxBytes,
              codePatchMaxBytes: settings.codePatchMaxBytes,
              codePdfMaxPages: settings.codePdfMaxPages,
              codePdfRenderScale: settings.codePdfRenderScale,
            };
          },
        }),
      );
    },
    mounted(ctx) {
      ctx.effect(() =>
        ctx
          .get("executionScopes")
          .onRevoke(({ previous }) =>
            revokeTaskFileOperations(previous.workspaceId, previous.taskId),
          ),
      );
      void registerExecutionScopeRoutes(ctx.app, {
        auth: ctx.get("auth"),
        scopes: ctx.get("executionScopes"),
      });
    },
  };
}
