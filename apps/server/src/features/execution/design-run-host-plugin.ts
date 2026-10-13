import type { PluginDefinition } from "../../kernel/types.js";
import { createDesignModelSelection } from "./design-model-selection.js";
import { createDesignRunHost } from "./design-run-host.js";
import { createDesignHostRepository } from "./design-run-host-repository.js";

export function createDesignRunHostPlugin(): PluginDefinition {
  return {
    name: "design-run-host",
    inject: [
      "modelProviders",
      "modelCatalog",
      "settings",
      "persistence",
      "agentModes",
      "designTasks",
      "designGoals",
      "agentRuns",
      "agentRunMetadata",
      "threads",
      "executionScopes",
      "localInstance",
      "localAccess",
      "taskWork",
    ],
    apply(ctx) {
      ctx.register("designRunHost", () =>
        createDesignRunHost({
          modelSelection: createDesignModelSelection({
            modelProviders: ctx.get("modelProviders"),
            modelCatalog: ctx.get("modelCatalog"),
            settings: ctx.get("settings"),
          }),
          agentModes: ctx.get("agentModes"),
          repository: createDesignHostRepository(ctx.get("persistence")),
          designTasks: ctx.get("designTasks"),
          designGoals: ctx.get("designGoals"),
          agentRuns: ctx.get("agentRuns"),
          metadata: ctx.get("agentRunMetadata"),
          threads: ctx.get("threads"),
          executionScopes: ctx.get("executionScopes"),
          localInstance: ctx.get("localInstance"),
          localAccess: ctx.get("localAccess"),
          taskWork: ctx.get("taskWork"),
        }),
      );
      ctx.effect(() => async () => {
        await ctx.tryGet("designRunHost")?.close();
      });
    },
    mounted(ctx) {
      ctx.app.addHook("onReady", async () => {
        await ctx.get("designRunHost").initialize();
      });
    },
  };
}
