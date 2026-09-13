import { registerAdminRoutes } from "../../http/admin.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createAdminService } from "./admin-service.js";

/**
 * admin 插件（FORM-10）：平台管理后台服务缝。
 * - `admin` ctx key：管理员判定 + 用户/额度/角色管理 + 平台用量；
 * - HTTP 路由（`/api/admin/*`）在 mounted 挂载，**全部端点服务端 403 门**；
 * - 系统供应商（平台池）复用 `modelProviders` 缝，不另建一套实例存储。
 */
export function createAdminPlugin(deps: {
  getAdminClient: () => AdminSupabaseClient;
  /** HTTP 进程挂路由（需 auth）；其他形态传 false。 */
  withRoutes?: boolean;
}): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "admin",
    inject: ["auth", "credits", "modelProviders"],
    apply(ctx) {
      const service = createAdminService({
        getAdminClient: deps.getAdminClient,
        credits: ctx.get("credits"),
      });
      ctx.register("admin", () => service);
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      void registerAdminRoutes(ctx.app, {
        auth: ctx.get("auth"),
        admin: ctx.get("admin"),
        modelProviders: ctx.get("modelProviders"),
      });
    },
  };
}
