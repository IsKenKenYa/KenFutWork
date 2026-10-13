import { registerDesignGoalRoutes } from "../../http/design-goals.js";
import type { PluginDefinition } from "../../kernel/types.js";
export function createDesignGoalHttpPlugin(): PluginDefinition {
  return {
    name: "design-goal-http",
    inject: ["localAccess", "designGoals", "designTasks", "designRunHost"],
    apply() {},
    mounted(ctx) {
      void registerDesignGoalRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        designGoals: ctx.get("designGoals"),
        designTasks: ctx.get("designTasks"),
        designRunHost: ctx.get("designRunHost"),
      });
    },
  };
}
