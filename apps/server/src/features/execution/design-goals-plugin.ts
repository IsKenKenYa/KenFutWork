import type { PluginDefinition } from "../../kernel/types.js";
import { createGoalPrompt, createGoalTools } from "../goals/consumer.js";
import { createDesignGoals } from "./design-goals.js";
import {
  createDesignModelSelection,
  type DesignModelSelection,
} from "./design-model-selection.js";
export function createDesignGoalsPlugin(
  modelSelection?: DesignModelSelection,
): PluginDefinition {
  return {
    name: "design-goals",
    inject: [
      ...(modelSelection
        ? []
        : (["modelProviders", "modelCatalog", "settings"] as const)),
      "persistence",
      "goals",
      "permissions",
      "localInstance",
    ],
    apply(ctx) {
      ctx.register("designGoals", () =>
        createDesignGoals({
          modelSelection:
            modelSelection ??
            createDesignModelSelection({
              modelProviders: ctx.get("modelProviders"),
              modelCatalog: ctx.get("modelCatalog"),
              settings: ctx.get("settings"),
            }),
          persistence: ctx.get("persistence"),
          goals: ctx.get("goals"),
          permissions: ctx.get("permissions"),
          localInstance: ctx.get("localInstance"),
        }),
      );
      const host = {
        read: (
          context: Parameters<ReturnType<typeof createDesignGoals>["read"]>[0],
        ) => ctx.get("designGoals").read(context),
        verify: (
          context: Parameters<
            ReturnType<typeof createDesignGoals>["verify"]
          >[0],
          input: Parameters<ReturnType<typeof createDesignGoals>["verify"]>[1],
        ) => ctx.get("designGoals").verify(context, input),
      };
      ctx
        .get("systemPrompt")
        .register(createGoalPrompt(host, { scope: "design" }));
      for (const name of ["GetGoal", "VerifyGoal"])
        ctx.get("tools").registerDynamic({
          id: `design.goal.${name}`,
          scope: "design",
          resolve(run) {
            if (
              run.scopeHandle?.preset !== "design" ||
              run.scopeHandle.role !== "main" ||
              run.scopeHandle.agentId !== "main"
            )
              return null;
            return (
              createGoalTools(host, { scope: "design" }).find(
                (tool) => tool.name === name,
              ) ?? null
            );
          },
        });
      ctx.effect(() => async () => {
        await ctx.tryGet("designGoals")?.close();
      });
    },
  };
}
