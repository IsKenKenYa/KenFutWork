import { registerCanvasRoutes } from "../../http/canvases.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createCanvasService } from "./canvas-service.js";
import { createCanvasRepository } from "./repository.js";

/**
 * canvas 插件：画布内容服务 + HTTP 路由（路由注册放 mounted）。
 * 数据访问经 `persistence` 缝；工作区由 viewer 解析（路由不再依赖 RLS）。
 * `createUserClient` 仅剩画布文件对象存储用途，随 M3 blob 缝移除。
 */
export function createCanvasPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "canvas",
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      ctx.register("canvas", () =>
        createCanvasService({
          createUserClient: deps.createUserClient,
          repository: createCanvasRepository(ctx.get("persistence")),
          viewerService: ctx.get("viewer"),
        }),
      );
    },
    mounted(ctx) {
      void registerCanvasRoutes(ctx.app, {
        auth: ctx.get("auth"),
        canvasService: ctx.get("canvas"),
      });
    },
  };
}
