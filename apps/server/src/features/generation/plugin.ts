import type { ServerEnv } from "../../config/env.js";
import { registerGenerateRoutes } from "../../http/generate.js";
import { registerImageModelRoutes } from "../../http/image-models.js";
import { registerModelRoutes } from "../../http/models.js";
import { registerVideoModelRoutes } from "../../http/video-models.js";
import type { PluginDefinition } from "../../kernel/types.js";

/**
 * generation 插件（P8）：图/视频模型目录 + 直连生成路由收编。
 * 服务依赖（credits/uploads/viewer 等）经 ctx 解析；provider 按实例实例化见
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
      "auth",
      "credits",
      "tierGuard",
      "uploads",
      "viewer",
      "jobs",
      "modelCatalog",
    ],
    apply() {},
    mounted(ctx) {
      void registerModelRoutes(ctx.app, {
        env: deps.env,
        auth: ctx.get("auth"),
        modelCatalog: ctx.get("modelCatalog"),
      });
      void registerImageModelRoutes(ctx.app, {
        auth: ctx.get("auth"),
        modelCatalog: ctx.get("modelCatalog"),
      });
      void registerVideoModelRoutes(ctx.app, {
        auth: ctx.get("auth"),
        modelCatalog: ctx.get("modelCatalog"),
      });
      void registerGenerateRoutes(ctx.app, {
        auth: ctx.get("auth"),
        creditService: ctx.get("credits"),
        uploadService: ctx.get("uploads"),
        viewerService: ctx.get("viewer"),
        tierGuard: ctx.get("tierGuard"),
        modelProviders: ctx.get("modelProviders"),
        jobService: ctx.get("jobs"),
      });
    },
  };
}
