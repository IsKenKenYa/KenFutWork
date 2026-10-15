import { registerCanvasRoutes } from "../../http/canvases.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { CODE_UI_WORK_CONTEXT_CAPABILITY } from "../code-ui/work-context.js";
import { createCanvasService } from "./canvas-service.js";
import { createCanvasDocumentAccess } from "./document-access.js";
import {
  canvasDesignPromptSection,
  canvasSelectionPromptSection,
} from "./prompt.js";
import { createCanvasRepository } from "./repository.js";
import { createCanvasDocumentToolDefinitions } from "./tools/document-tools.js";
import { createInspectCanvasToolDefinition } from "./tools/inspect-canvas.js";
import { createManipulateCanvasToolDefinition } from "./tools/manipulate-canvas.js";
import { createScreenshotCanvasToolDefinition } from "./tools/screenshot-canvas.js";

/** 文件内容Provider与HTTP入口不依赖WS，供Agent/WS场景读取复用。 */
export function createCanvasPlugin(
  options: { withRoutes?: boolean } = {},
): PluginDefinition {
  return {
    name: "canvas",
    inject: [
      ...(options.withRoutes === false ? [] : ["localAccess" as const]),
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
      if (options.withRoutes === false) return;
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
      "brandKit",
      "settings",
      "ws",
      "blob",
      "projectFiles",
      "localInstance",
      "projects",
      "persistence",
      "capabilities",
      "tools",
      "systemPrompt",
    ],
    apply() {},
    mounted(ctx) {
      const documentAccess = createCanvasDocumentAccess({
        persistence: ctx.get("persistence"),
        localInstance: ctx.get("localInstance"),
        projects: ctx.get("projects"),
        canvas: ctx.get("canvas"),
        canvases: createCanvasRepository(ctx.get("persistence")),
        projectFiles: ctx.get("projectFiles"),
        brandKit: ctx.get("brandKit"),
        settings: ctx.get("settings"),
      });
      ctx.get("capabilities").register(CODE_UI_WORK_CONTEXT_CAPABILITY, {
        id: "design",
        value: documentAccess,
      });
      const tools = ctx.get("tools");
      for (const tool of createCanvasDocumentToolDefinitions({
        canvas: ctx.get("canvas"),
        access: documentAccess,
      }))
        tools.register(tool);
      tools.register(
        createInspectCanvasToolDefinition({
          canvasService: ctx.get("canvas"),
          localInstance: ctx.get("localInstance"),
          documentAccess,
        }),
      );
      tools.register(
        createManipulateCanvasToolDefinition({
          canvasService: ctx.get("canvas"),
          localInstance: ctx.get("localInstance"),
          documentAccess,
        }),
      );
      tools.register(
        createScreenshotCanvasToolDefinition({
          projectFiles: ctx.get("projectFiles"),
          connectionManager: ctx.get("ws").connectionManager,
          blob: ctx.get("blob"),
          localInstance: ctx.get("localInstance"),
          documentAccess,
        }),
      );

      // design 模式段：提示与工具同属主、同装卸（挂载即出现）
      ctx.get("systemPrompt").register(canvasDesignPromptSection);
      ctx.get("systemPrompt").register(canvasSelectionPromptSection);
    },
  };
}
