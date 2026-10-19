import type { PluginDefinition } from "../../kernel/types.js";
import { createApprovalReviewService } from "./approval-review-service.js";

export function createApprovalReviewPlugin(): PluginDefinition {
  return {
    name: "approval-review",
    inject: ["settings", "modelProviders", "modelCatalog"],
    apply(ctx) {
      ctx.register("approvalReview", () =>
        createApprovalReviewService({
          settings: ctx.get("settings"),
          providers: ctx.get("modelProviders"),
          catalog: ctx.get("modelCatalog"),
        }),
      );
    },
    mounted(ctx) {
      ctx.effect(() => {
        const service = ctx.get("approvalReview");
        const settings = ctx.get("settings").onUpdated(({ changedKeys }) => {
          if (changedKeys.includes("modelDefaults")) service.invalidate();
        });
        const providers = ctx
          .get("modelProviders")
          .onChanged?.(({ providerId }) => service.invalidate(providerId));
        return () => {
          settings();
          providers?.();
          service.close();
        };
      });
    },
  };
}
