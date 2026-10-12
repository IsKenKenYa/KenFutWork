import { registerDesignApprovalRoutes } from "../../http/design-approvals.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createDesignApprovalsService } from "./design-approvals.js";

export function createDesignApprovalsPlugin(): PluginDefinition {
  return {
    name: "design-approvals",
    inject: ["localAccess", "designTasks", "permissions"],
    apply() {
      return undefined;
    },
    mounted(ctx) {
      registerDesignApprovalRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        approvals: createDesignApprovalsService({
          designTasks: ctx.get("designTasks"),
          permissions: ctx.get("permissions"),
        }),
      });
    },
  };
}
