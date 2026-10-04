import { registerCodeUiRoutes } from "../../http/code-ui.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCodeUiRepository } from "./repository.js";
import { createCodeUiService } from "./service.js";

export function createCodeUiPlugin(): PluginDefinition {
  return {
    name: "code-ui",
    inject: [
      "auth",
      "viewer",
      "persistence",
      "projects",
      "modelProviders",
      "modelCatalog",
      "settings",
      "threads",
      "agentRuns",
      "agentRunMetadata",
      "plugins",
      "admin",
    ],
    apply(ctx) {
      ctx.register("codeUi", () =>
        createCodeUiService({
          repository: createCodeUiRepository(ctx.get("persistence")),
          viewer: ctx.get("viewer"),
          projects: ctx.get("projects"),
          modelProviders: ctx.get("modelProviders"),
          modelCatalog: ctx.get("modelCatalog"),
          settings: ctx.get("settings"),
          threads: ctx.get("threads"),
          agentRuns: ctx.get("agentRuns"),
          agentRunMetadata: ctx.get("agentRunMetadata"),
          plugins: ctx.get("plugins"),
          admin: ctx.get("admin"),
          env: ctx.env,
        }),
      );
    },
    mounted(ctx) {
      void registerCodeUiRoutes(ctx.app, {
        auth: ctx.get("auth"),
        service: ctx.get("codeUi"),
      });
    },
  };
}
