import { homeLibraryResponseSchema } from "@loomic/shared";

import { registerHomeRoutes } from "../../http/home.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createHomeRepository } from "./repository.js";
import { createHomeService } from "./service.js";

/**
 * home 插件：首页示例库 / 发现库（Design 模式首页的灵感内容）。
 *
 * 数据是**静态产品种子**（`home_example_examples` / `home_discovery_cases` /
 * `home_example_categories`，无租户列），素材为相对对象引用，经 blob 缝解析成 URL 后下发。
 * 路由挂 `/api/home/library`（认证门与其它业务路由一致）。
 */
export function createHomePlugin(): PluginDefinition {
  return {
    name: "home",
    inject: ["auth", "blob", "persistence"],
    apply(ctx) {
      const service = createHomeService({
        blob: ctx.get("blob"),
        repository: createHomeRepository(ctx.get("persistence")),
      });
      ctx.register("home", () => service);
    },
    mounted(ctx) {
      const service = ctx.get("home");
      void registerHomeRoutes(ctx.app, {
        auth: ctx.get("auth"),
        service,
        // 契约校验在这里做一次：响应形状由共享契约定义，漂移即 500 而不是发坏数据
        parse: (payload) => homeLibraryResponseSchema.parse(payload),
      });
    },
  };
}
