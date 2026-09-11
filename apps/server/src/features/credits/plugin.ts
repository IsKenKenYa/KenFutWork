import { registerCreditRoutes } from "../../http/credits.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createCreditService } from "./credit-service.js";
import { createTierGuard } from "./tier-guard.js";

/**
 * credits 插件：计费三件套中的 credits + tierGuard（payments 独立成插件）。
 * DEC-5：目标态（桌面/自托管）默认关闭；迁移期保持恒启用，行为不变。
 * 路由消费 viewer 服务，inject 声明 viewer；路由注册放 mounted。
 */
export function createCreditsPlugin(deps: {
  getAdminClient: () => AdminSupabaseClient;
}): PluginDefinition {
  return {
    name: "credits",
    inject: ["auth", "viewer"],
    apply(ctx) {
      ctx.register("credits", () =>
        createCreditService({ getAdminClient: deps.getAdminClient }),
      );
      ctx.register("tierGuard", () =>
        createTierGuard({ getAdminClient: deps.getAdminClient }),
      );
    },
    mounted(ctx) {
      void registerCreditRoutes(ctx.app, {
        auth: ctx.get("auth"),
        creditService: ctx.get("credits"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
