import { registerUploadRoutes } from "../../http/uploads.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createAssetWriter } from "./asset-writer.js";
import { createUploadRepository } from "./repository.js";
import { createUploadService } from "./upload-service.js";

/**
 * uploads 插件：上传服务 + HTTP 路由（路由消费 本地实例服务；generate 直连链路另消费 uploads）
 * + **`assetWriter` 缝**（worker/executor 路径的生成物元数据写入）。
 *
 * 两条路径同写 `asset_objects`，但依赖不同：路由路径的身份来自鉴权用户、实例由
 * 本地实例服务 解析；worker 两者都没有，只能按任务记录里的实例写入。故 `withRoutes: false`
 * 时只注册 `assetWriter`（`inject` 收窄为 `persistence`），路由与服务不注册。
 *
 * 对象存储经 `blob` 缝（M3.1 起）：本插件不再持有旧账户客户端——
 * `assetWriter` 只写元数据行，`uploads` 服务的上传/签名/删除都走 `blob`。
 */
export function createUploadsPlugin(
  deps: {
    /** HTTP 进程挂路由（需 auth/blob/本地实例服务）；worker 传 false。 */
    withRoutes?: boolean;
  } = {},
): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "uploads",
    inject: withRoutes
      ? ["localAccess", "blob", "persistence", "localInstance"]
      : ["persistence"],
    apply(ctx) {
      const repository = createUploadRepository(ctx.get("persistence"));
      ctx.register("assetWriter", () => createAssetWriter(repository));

      if (!withRoutes) {
        return;
      }

      ctx.register("uploads", () =>
        createUploadService({
          blob: ctx.get("blob"),
          repository,
          localInstance: ctx.get("localInstance"),
        }),
      );
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      void registerUploadRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        uploadService: ctx.get("uploads"),
        localInstance: ctx.get("localInstance"),
      });
    },
  };
}
