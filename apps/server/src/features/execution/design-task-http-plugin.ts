import { registerDesignTaskRoutes } from "../../http/design-tasks.js";
import type { PluginDefinition } from "../../kernel/types.js";

export function createDesignTaskHttpPlugin(): PluginDefinition {
  return {
    name: "design-task-http",
    inject: ["localAccess", "designTasks"],
    apply() {},
    mounted(ctx) {
      void registerDesignTaskRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        designTasks: ctx.get("designTasks"),
      });
    },
  };
}
