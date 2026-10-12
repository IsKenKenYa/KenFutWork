import type { PluginDefinition } from "../../kernel/types.js";
import { createDesignTasksService } from "./design-tasks.js";

export function createDesignTasksPlugin(): PluginDefinition {
  return {
    name: "design-tasks",
    inject: ["persistence", "localInstance", "designGoals"],
    apply(ctx) {
      ctx.register("designTasks", () =>
        createDesignTasksService({
          persistence: ctx.get("persistence"),
          localInstance: ctx.get("localInstance"),
          sandboxRoot: ctx.env.sandboxRoot,
          goalLifecycle: ctx.get("designGoals").lifecycle,
        }),
      );
      ctx.effect(() => async () => {
        await ctx.tryGet("designTasks")?.close();
      });
    },
  };
}
