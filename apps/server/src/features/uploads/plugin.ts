import { registerUploadRoutes } from "../../http/uploads.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createUploadService } from "./upload-service.js";

/** uploads 插件：上传服务 + HTTP 路由（路由消费 viewer；generate 直连链路另消费 uploads）。 */
export function createUploadsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "uploads",
    inject: ["auth", "viewer"],
    apply(ctx) {
      ctx.register("uploads", () =>
        createUploadService({ createUserClient: deps.createUserClient }),
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
