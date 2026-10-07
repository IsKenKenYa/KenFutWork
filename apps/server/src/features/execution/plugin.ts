import { registerExecutionScopeRoutes } from "../../http/execution-scopes.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { executionScopePromptSection } from "./prompt.js";
import { createScopeRepository } from "./scope-repository.js";
import { createExecutionScopes } from "./scope-service.js";
import { revokeTaskFileOperations } from "./scoped-filesystem.js";

export function createExecutionScopesPlugin(): PluginDefinition {
  return {
    name: "execution-scopes",
    inject: ["localAccess", "persistence", "localInstance", "settings"],
    apply(ctx) {
      ctx.get("systemPrompt").register(executionScopePromptSection);
      ctx.register("executionScopes", () =>
        createExecutionScopes({
          repository: createScopeRepository(ctx.get("persistence")),
          localInstance: ctx.get("localInstance"),
          resolveFileLimits: async (actor, scope) => {
            const settings = await ctx
              .get("settings")
              .getInstanceSettings(actor, scope.instanceId);
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
            revokeTaskFileOperations(previous.instanceId, previous.taskId),
          ),
      );
      void registerExecutionScopeRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        scopes: ctx.get("executionScopes"),
      });
    },
  };
}
