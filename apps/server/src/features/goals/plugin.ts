import type { PluginDefinition } from "../../kernel/types.js";
import { createGoalService } from "./service.js";
export function createGoalsPlugin(): PluginDefinition {
  return {
    name: "goals",
    inject: [],
    apply(ctx) {
      ctx.register("goals", () => createGoalService());
    },
  };
}
