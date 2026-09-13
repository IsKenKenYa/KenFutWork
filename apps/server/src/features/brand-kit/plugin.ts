import { registerBrandKitRoutes } from "../../http/brand-kits.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createBrandKitService } from "./brand-kit-service.js";
import { createBrandKitRepository } from "./repository.js";

/**
 * brand-kit 插件（P2 试点）：服务定义 + Provider + Consumer（HTTP 路由）内聚。
 * 测试注入用 kernel overrides 替换 brandKit 服务实例。
 */
export const brandKitPlugin: PluginDefinition = {
  name: "brand-kit",
  inject: ["auth", "blob", "persistence"],
  apply(ctx) {
    ctx.register("brandKit", () =>
      createBrandKitService({
        blob: ctx.get("blob"),
        repository: createBrandKitRepository(ctx.get("persistence")),
      }),
    );
    void registerBrandKitRoutes(ctx.app, {
      auth: ctx.get("auth"),
      brandKitService: ctx.get("brandKit"),
    });
  },
};
