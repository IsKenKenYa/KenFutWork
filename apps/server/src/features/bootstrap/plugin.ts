import { registerViewerRoutes } from "../../http/viewer.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createViewerService } from "./ensure-user-foundation.js";
import { createViewerRepository } from "./repository.js";

/**
 * viewer 插件：用户/工作区引导服务 + HTTP 路由。
 * 路由消费 credits 服务（余额展示），故 inject 声明 credits；路由注册放 mounted
 * （apply 期其他插件的服务工厂尚未全部登记，跨服务接线统一在 mounted 做）。
 * 数据访问经 `persistence` 缝（M1.3 起不再持有 Supabase 客户端）。
 */
export function createViewerPlugin(): PluginDefinition {
  return {
    name: "viewer",
    inject: ["auth", "credits", "persistence"],
    apply(ctx) {
      ctx.register("viewer", () =>
        createViewerService({
          repository: createViewerRepository(ctx.get("persistence")),
        }),
      );
    },
    mounted(ctx) {
      void registerViewerRoutes(ctx.app, {
        auth: ctx.get("auth"),
        creditService: ctx.get("credits"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
