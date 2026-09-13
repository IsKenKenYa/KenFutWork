import { registerUploadRoutes } from "../../http/uploads.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createUploadRepository } from "./repository.js";
import { createUploadService } from "./upload-service.js";

/**
 * uploads 插件：上传服务 + HTTP 路由（路由消费 viewer；generate 直连链路另消费 uploads）。
 * 元数据经 `persistence` 缝；`createUserClient` 仅剩对象存储用途，随 M3 blob 缝移除。
 */
export function createUploadsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "uploads",
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      ctx.register("uploads", () =>
        createUploadService({
          createUserClient: deps.createUserClient,
          repository: createUploadRepository(ctx.get("persistence")),
          viewerService: ctx.get("viewer"),
        }),
      );
    },
    mounted(ctx) {
      void registerUploadRoutes(ctx.app, {
        auth: ctx.get("auth"),
        uploadService: ctx.get("uploads"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
