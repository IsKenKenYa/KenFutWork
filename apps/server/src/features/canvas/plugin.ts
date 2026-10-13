import { registerCanvasRoutes } from "../../http/canvases.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCanvasService } from "./canvas-service.js";
import { canvasDesignPromptSection } from "./prompt.js";
import { createCanvasRepository } from "./repository.js";
import { createInspectCanvasToolDefinition } from "./tools/inspect-canvas.js";
import { createManipulateCanvasToolDefinition } from "./tools/manipulate-canvas.js";
import { createScreenshotCanvasToolDefinition } from "./tools/screenshot-canvas.js";

/** 文件内容Provider与HTTP入口不依赖WS，供Agent/WS场景读取复用。 */
export function createCanvasPlugin(): PluginDefinition {
  return {
    name: "canvas",
    inject: [
      "localAccess",
      "blob",
      "persistence",
      "localInstance",
      "projects",
      "projectFiles",
    ],
    apply(ctx) {
      const canvasRepository = createCanvasRepository(ctx.get("persistence"));
      ctx.register("canvas", () =>
        createCanvasService({
          blob: ctx.get("blob"),
          repository: canvasRepository,
          localInstance: ctx.get("localInstance"),
          projects: ctx.get("projects"),
          projectFiles: ctx.get("projectFiles"),
        }),
      );
    },
    mounted(ctx) {
      void registerCanvasRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        canvasService: ctx.get("canvas"),
      });
    },
  };
}

/** 工具与提示Consumer依赖既有canvas服务，截图才依赖WS。 */
export function createCanvasToolsPlugin(): PluginDefinition {
  return {
    name: "canvas:tools",
    inject: [
      "canvas",
      "ws",
      "blob",
      "projectFiles",
      "localInstance",
      "designTasks",
      "tools",
      "systemPrompt",
    ],
    apply() {},
    mounted(ctx) {
      const tools = ctx.get("tools");
      tools.register(
        createInspectCanvasToolDefinition({
          canvasService: ctx.get("canvas"),
          localInstance: ctx.get("localInstance"),
          designTasks: ctx.get("designTasks"),
        }),
      );
      tools.register(
        createManipulateCanvasToolDefinition({
          canvasService: ctx.get("canvas"),
          localInstance: ctx.get("localInstance"),
          designTasks: ctx.get("designTasks"),
        }),
      );
      tools.register(
        createScreenshotCanvasToolDefinition({
          projectFiles: ctx.get("projectFiles"),
          connectionManager: ctx.get("ws").connectionManager,
          blob: ctx.get("blob"),
          localInstance: ctx.get("localInstance"),
          designTasks: ctx.get("designTasks"),
        }),
      );

      // design 模式段：提示与工具同属主、同装卸（挂载即出现）
      ctx.get("systemPrompt").register(canvasDesignPromptSection);
    },
  };
}
