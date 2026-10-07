import type { ServerEnv } from "../../config/env.js";
import { registerGenerateRoutes } from "../../http/generate.js";
import { registerImageModelRoutes } from "../../http/image-models.js";
import { registerModelRoutes } from "../../http/models.js";
import { registerVideoModelRoutes } from "../../http/video-models.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createImageGenerateToolDefinition } from "./tools/image-generate.js";
import { createVideoGenerateToolDefinition } from "./tools/video-generate.js";

/**
 * generation 插件（P8）：图/视频模型目录 + 直连生成路由收编 + **生成工具**
 * （generate_image / generate_video，scope=design）。工具是 per-run 动态的：
 * schema 内嵌工作区模型目录、job 闭包捕获 run 上下文——经内核动态工具缝
 * 在 run 起始期解析（§4.10）。
 * 服务依赖（uploads/localInstance 等）经 ctx 解析；provider 按实例实例化见
 * providers/resolve.ts（遗留 env 注册并行至 BYOK 切换）。
 */
export function createGenerationPlugin(deps: {
  env: ServerEnv;
}): PluginDefinition {
  return {
    name: "generation",
    // `jobs` 是直连视频生成的必需依赖（建 job + 轮询终态）——真机踩过：
    // 漏了它时路由恒走「jobService 未配置」分支，视频生成整条不可用。
    inject: [
      "localAccess",
      "uploads",
      "localInstance",
      "jobs",
      "modelCatalog",
      "modelProviders",
      "usage",
    ],
    apply(ctx) {
      const tools = ctx.get("tools");
      tools.registerDynamic({
        id: "generation.image",
        scope: "design",
        resolve: (run) =>
          createImageGenerateToolDefinition({
            ...(run.persistImage ? { persistImage: run.persistImage } : {}),
            ...(run.submitImageJob
              ? { submitImageJob: run.submitImageJob }
              : {}),
            ...(run.availableImageModels
              ? { availableModels: run.availableImageModels }
              : {}),
          }),
      });
      tools.registerDynamic({
        id: "generation.video",
        scope: "design",
        resolve: (run) =>
          createVideoGenerateToolDefinition({
            ...(run.submitVideoJob
              ? { submitVideoJob: run.submitVideoJob }
              : {}),
            ...(run.availableVideoModels
              ? { availableModels: run.availableVideoModels }
              : {}),
          }),
      });
    },
    mounted(ctx) {
      void registerModelRoutes(ctx.app, {
        env: deps.env,
        localAccess: ctx.get("localAccess"),
        modelCatalog: ctx.get("modelCatalog"),
      });
      void registerImageModelRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        modelCatalog: ctx.get("modelCatalog"),
      });
      void registerVideoModelRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        modelCatalog: ctx.get("modelCatalog"),
      });
      void registerGenerateRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        uploadService: ctx.get("uploads"),
        usage: ctx.get("usage"),
        localInstance: ctx.get("localInstance"),
        modelProviders: ctx.get("modelProviders"),
        jobService: ctx.get("jobs"),
      });
    },
  };
}
