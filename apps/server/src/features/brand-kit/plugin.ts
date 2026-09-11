import { registerBrandKitRoutes } from "../../http/brand-kits.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createUserSupabaseClientFactory } from "../../supabase/user.js";
import { createBrandKitService } from "./brand-kit-service.js";

/**
 * brand-kit 插件（P2 试点）：服务定义 + Provider + Consumer（HTTP 路由）内聚。
 * 测试注入用 kernel overrides 替换 brandKit 服务实例。
 */
export const brandKitPlugin: PluginDefinition = {
  name: "brand-kit",
  inject: ["auth"],
  apply(ctx) {
    ctx.register("brandKit", () =>
      createBrandKitService({
        createUserClient: createUserSupabaseClientFactory(ctx.env),
      }),
    );
    void registerBrandKitRoutes(ctx.app, {
      auth: ctx.get("auth"),
      brandKitService: ctx.get("brandKit"),
    });
  },
};
