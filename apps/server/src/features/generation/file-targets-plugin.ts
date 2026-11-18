import type { PluginDefinition } from "../../kernel/types.js";
import { createGenerationTargets } from "./file-targets.js";
export function createGenerationTargetsPlugin(): PluginDefinition {
  return {
    name: "generationTargets",
    inject: ["persistence", "executionScopes"],
    apply(ctx) {
      ctx.register("generationTargets", () =>
        createGenerationTargets({
          persistence: ctx.get("persistence"),
          executionScopes: ctx.get("executionScopes"),
        }),
      );
    },
  };
}
