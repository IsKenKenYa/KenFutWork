import { registerViewerRoutes } from "../../http/viewer.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createUserSupabaseClientFactory } from "../../supabase/user.js";
import { createViewerService } from "./ensure-user-foundation.js";

/**
 * viewer 插件：用户/工作区引导服务 + HTTP 路由。
 * 路由消费 credits 服务（余额展示），故 inject 声明 credits；路由注册放 mounted
 * （apply 期其他插件的服务工厂尚未全部登记，跨服务接线统一在 mounted 做）。
 */
export function createViewerPlugin(deps: {
  getAdminClient: () => AdminSupabaseClient;
}): PluginDefinition {
  return {
    name: "viewer",
    inject: ["auth", "credits"],
    apply(ctx) {
      ctx.register("viewer", () =>
        createViewerService({ getAdminClient: deps.getAdminClient }),
      );
    },
    mounted(ctx) {
      void registerViewerRoutes(ctx.app, {
        auth: ctx.get("auth"),
        createUserClient: createUserSupabaseClientFactory(ctx.env),
        creditService: ctx.get("credits"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
