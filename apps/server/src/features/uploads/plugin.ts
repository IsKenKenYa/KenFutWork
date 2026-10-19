import { registerUploadRoutes } from "../../http/uploads.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createAssetWriter } from "./asset-writer.js";
import { createUploadRepository } from "./repository.js";
import { createUploadService } from "./upload-service.js";

/** HTTP与worker共用上传/素材读取服务；withRoutes只控制HTTP面。 */
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
      : ["blob", "persistence", "localInstance"],
    apply(ctx) {
      const repository = createUploadRepository(ctx.get("persistence"));
      ctx.register("assetWriter", () => createAssetWriter(repository));

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
