import { registerCanvasRoutes } from "../../http/canvases.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createCanvasService } from "./canvas-service.js";

/** canvas 插件：画布内容服务 + HTTP 路由（无 viewer 依赖，路由注册放 mounted）。 */
export function createCanvasPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "canvas",
    inject: ["auth"],
    apply(ctx) {
      ctx.register("canvas", () =>
        createCanvasService({ createUserClient: deps.createUserClient }),
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
