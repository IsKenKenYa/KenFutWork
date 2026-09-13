import { registerBlobRoutes } from "../../http/blobs.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createLocalFsBlobStore } from "./providers/local-fs.js";
import type { BlobStore } from "./types.js";

/**
 * blob 插件（M3.1）：对象存储缝的 Provider 选择。
 *
 * **当前只有本地 FS 形态**（桌面 / 本地开发 / 自托管单机）：目录 `<LOOMIC_BLOB_DIR>`，
 * 对外 URL 走 server 自己的 `/api/blobs` 读取路由。原 Supabase Storage Provider 已随
 * M1.5 删除——它在过渡期承担了「不改业务代码先切缝」的角色，现在使命完成。
 *
 * 后续接入 MinIO（自托管多机）时新增一个 Provider 并在下面按 env 选择即可，消费方不动。
 *
 * **不做 enabled 门控**：对象存储是必需能力（projects/brand-kit/canvas/uploads/生成
 * executor 都要写对象）；配置缺失即启动期失败，不静默降级。
 */
export function createBlobPlugin(
  deps: {
    /** HTTP 进程挂读取路由；worker 传 false（worker 无 app，只有消费方需要 blob 句柄）。 */
    withRoutes?: boolean;
  } = {},
): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  let blob: BlobStore | undefined;

  return {
    name: "blob",
    inject: ["persistence"],
    apply(ctx) {
      const rootDir = ctx.env.blobDir;
      const signingSecret = ctx.env.credentialSecret;

      if (!rootDir) {
        throw new Error(
          "[blob] 缺少 LOOMIC_BLOB_DIR（本地对象根目录）——对象存储是必需能力，配置缺失即失败。",
        );
      }
      if (!signingSecret) {
        throw new Error(
          "[blob] 缺少 LOOMIC_CREDENTIAL_SECRET（blob 签名密钥）。",
        );
      }

      blob = createLocalFsBlobStore({
        publicBaseUrl:
          ctx.env.blobPublicBaseUrl ?? "http://127.0.0.1:3001/api/blobs",
        rootDir,
        signingSecret,
      });
      ctx.register("blob", () => {
        if (!blob) throw new Error("[blob] Provider 尚未初始化。");
        return blob;
      });
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      const rootDir = ctx.env.blobDir;
      const signingSecret = ctx.env.credentialSecret;
      if (!rootDir || !signingSecret) {
        // apply 已 fail loud；此处只是类型收窄（同一次启动不会走到这里）
        throw new Error(
          "[blob] 缺少 LOOMIC_BLOB_DIR / LOOMIC_CREDENTIAL_SECRET。",
        );
      }
      void registerBlobRoutes(ctx.app, { rootDir, signingSecret });
    },
  };
}
