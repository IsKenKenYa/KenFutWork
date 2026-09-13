import { registerBlobRoutes } from "../../http/blobs.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import { createLocalFsBlobStore } from "./providers/local-fs.js";
import { createSupabaseBlobStore } from "./providers/supabase-storage.js";
import type { BlobStore } from "./types.js";

/**
 * blob 插件（M3.1）：对象存储缝的 Provider 选择。
 *
 * 两种形态（《多端产品设计》§5）：
 * - **`supabase`（过渡期 / 自托管现状；默认）**：包住 Supabase Storage。
 * - **`local`（桌面）**：本地文件系统 + server 自己的读取路由（FORM-2「本地 blob」）；
 *   要求 `LOOMIC_BLOB_DIR`，签名密钥复用 `LOOMIC_CREDENTIAL_SECRET`。
 *   后续自托管形态切 MinIO 时新增 Provider 即可，消费方不动。
 *
 * **不做 enabled 门控**：对象存储是**必需能力**（projects/brand-kit/canvas/uploads/生成
 * executor 都要写对象），需要它却拿不到就应启动期失败——这正是内核 fail loud 的用途。
 * 仅「选了形态但缺该形态的必要配置」与「形态名不认识」会抛错，不静默降级。
 */
export function createBlobPlugin(deps: {
  getAdminClient: () => AdminSupabaseClient;
}): PluginDefinition {
  return {
    name: "blob",
    inject: ["persistence"],
    apply(ctx) {
      ctx.register("blob", () => resolveBlobStore(ctx.env, deps));
    },
    mounted(ctx) {
      if ((ctx.env.blobDriver ?? DEFAULT_BLOB_DRIVER) !== "local") {
        // supabase 形态的 URL 由 Storage 自己提供，无需本地读取路由
        return;
      }
      void registerBlobRoutes(ctx.app, {
        rootDir: ctx.env.blobDir as string,
        signingSecret: ctx.env.credentialSecret as string,
      });
    },
  };
}

/** 过渡期默认形态：既有部署都跑在 Supabase Storage 上。 */
export const DEFAULT_BLOB_DRIVER = "supabase";

export function resolveBlobStore(
  env: {
    blobDir?: string | undefined;
    blobDriver?: string | undefined;
    blobPublicBaseUrl?: string | undefined;
    credentialSecret?: string | undefined;
  },
  deps: { getAdminClient: () => AdminSupabaseClient },
): BlobStore {
  switch (env.blobDriver ?? DEFAULT_BLOB_DRIVER) {
    case "local": {
      if (!env.blobDir) {
        throw new Error(
          "[blob] LOOMIC_BLOB_DRIVER=local 需要 LOOMIC_BLOB_DIR（本地对象根目录）。",
        );
      }
      if (!env.credentialSecret) {
        throw new Error(
          "[blob] LOOMIC_BLOB_DRIVER=local 需要 LOOMIC_CREDENTIAL_SECRET（签名密钥）。",
        );
      }
      return createLocalFsBlobStore({
        publicBaseUrl:
          env.blobPublicBaseUrl ?? "http://127.0.0.1:3001/api/blobs",
        rootDir: env.blobDir,
        signingSecret: env.credentialSecret,
      });
    }
    case "supabase":
      return createSupabaseBlobStore({ getClient: deps.getAdminClient });
    default:
      throw new Error(
        `[blob] 未知 LOOMIC_BLOB_DRIVER：${String(env.blobDriver)}（可用：local | supabase）`,
      );
  }
}
