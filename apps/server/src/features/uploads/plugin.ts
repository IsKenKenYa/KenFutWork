import { registerUploadRoutes } from "../../http/uploads.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createAssetWriter } from "./asset-writer.js";
import { createUploadRepository } from "./repository.js";
import { createUploadService } from "./upload-service.js";

/**
 * uploads 插件：上传服务 + HTTP 路由（路由消费 viewer；generate 直连链路另消费 uploads）
 * + **`assetWriter` 缝**（worker/executor 路径的生成物元数据写入）。
 *
 * 两条路径同写 `asset_objects`，但依赖不同：路由路径的身份来自鉴权用户、工作区由
 * viewer 解析；worker 两者都没有，只能按任务记录里的工作区写入。故 `withRoutes: false`
 * 时只注册 `assetWriter`（`inject` 收窄为 `persistence`），路由与服务不注册。
 * 元数据经 `persistence` 缝；`createUserClient` 仅剩对象存储用途，随 M3 blob 缝移除。
 */
export function createUploadsPlugin(deps: {
  /** 用户客户端（仅路由/服务路径需要对象存储上传与签名）；worker 不传。 */
  createUserClient?: ((accessToken: string) => UserSupabaseClient) | undefined;
  /** HTTP 进程挂路由（需 auth/viewer）；worker 传 false。 */
  withRoutes?: boolean;
}): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "uploads",
    inject: withRoutes ? ["auth", "persistence", "viewer"] : ["persistence"],
    apply(ctx) {
      const repository = createUploadRepository(ctx.get("persistence"));
      ctx.register("assetWriter", () => createAssetWriter(repository));

      if (!withRoutes) {
        return;
      }

      const userClientFactory = deps.createUserClient;
      if (!userClientFactory) {
        // 配置 fail loud：挂了路由就必须有用户客户端（对象存储上传/签名依赖它）
        throw new Error("[uploads] 路由形态必须提供用户客户端工厂。");
      }

      ctx.register("uploads", () =>
        createUploadService({
          createUserClient: userClientFactory,
          repository,
          viewerService: ctx.get("viewer"),
        }),
      );
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      void registerUploadRoutes(ctx.app, {
        auth: ctx.get("auth"),
        uploadService: ctx.get("uploads"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
