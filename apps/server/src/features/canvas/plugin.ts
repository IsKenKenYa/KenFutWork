import { registerCanvasRoutes } from "../../http/canvases.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { ConnectionManager } from "../../ws/connection-manager.js";
import { createCanvasService } from "./canvas-service.js";
import { createCanvasRepository } from "./repository.js";
import { createInspectCanvasToolDefinition } from "./tools/inspect-canvas.js";
import { createManipulateCanvasToolDefinition } from "./tools/manipulate-canvas.js";
import { createScreenshotCanvasToolDefinition } from "./tools/screenshot-canvas.js";

export interface CanvasPluginDeps {
  /** 画布截图 RPC 的用户级路由（前端 canvas 页注册 handler）。 */
  connectionManager: ConnectionManager;
}

/**
 * canvas 插件：画布内容服务 + HTTP 路由 + **画布工具三件**（§4.10：工具注册权
 * 在属主 feature——inspect/manipulate/screenshot_canvas 向 ctx.tools 注册，
 * scope=design，Code 会话经 registry.list(preset) 结构性排除）。
 * 数据访问经 `persistence` 缝；工作区由 viewer 解析（路由不再依赖 RLS）。
 * 画布文件对象存储经 `blob` 缝。
 */
export function createCanvasPlugin(deps: CanvasPluginDeps): PluginDefinition {
  return {
    name: "canvas",
    inject: ["auth", "blob", "persistence", "viewer"],
    apply(ctx) {
      const canvasRepository = createCanvasRepository(ctx.get("persistence"));
      ctx.register("canvas", () =>
        createCanvasService({
          blob: ctx.get("blob"),
          repository: canvasRepository,
          viewerService: ctx.get("viewer"),
        }),
      );

      const tools = ctx.get("tools");
      tools.register(createInspectCanvasToolDefinition({ canvasRepository }));
      tools.register(
        createManipulateCanvasToolDefinition({ canvasRepository }),
      );
      tools.register(
        createScreenshotCanvasToolDefinition({
          connectionManager: deps.connectionManager,
          blob: ctx.get("blob"),
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
