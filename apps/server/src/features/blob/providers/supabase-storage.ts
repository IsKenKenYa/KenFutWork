import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type BlobBucket,
  type BlobStore,
  failBlob,
  SIGNED_URL_EXPIRY_SECONDS,
} from "../types.js";

/**
 * blob 缝的**过渡期 Provider**：包住 Supabase Storage。
 *
 * 用系统作用域（service role）而非用户令牌：按 `FORM-9` 隔离由应用层承担（对象路径
 * 由服务端拼入 workspaceId），故这里不必把用户令牌传进缝——桌面/自托管形态也就不必
 * 伪造令牌。行为与既有「用户令牌 + storage 策略」等价或更宽（服务角色本就绕过 RLS），
 * 消费方的路径拼装规则不变。
 */
export function createSupabaseBlobStore(options: {
  getClient: () => SupabaseClient;
}): BlobStore {
  return {
    bucket(name) {
      return createBucket(options.getClient, name);
    },
  };
}

function createBucket(
  getClient: () => SupabaseClient,
  bucket: string,
): BlobBucket {
  const from = () => getClient().storage.from(bucket);

  return {
    async isPublic() {
      const { data, error } = await getClient().storage.getBucket(bucket);
      if (error) {
        // 查不到公开性时按「非公开」处理：签名 URL 一定可用，公网 URL 未必
        return false;
      }
      return data?.public === true;
    },

    async resolveUrl(path, expiresInSeconds) {
      if (await this.isPublic()) {
        return this.getPublicUrl(path);
      }
      return this.createSignedUrl(
        path,
        expiresInSeconds ?? SIGNED_URL_EXPIRY_SECONDS,
      );
    },

    async upload(path, body, options) {
      const { error } = await from().upload(path, body, {
        ...(options?.contentType ? { contentType: options.contentType } : {}),
        upsert: options?.upsert ?? false,
      });
      if (error) {
        failBlob("upload", bucket, path, new Error(error.message));
      }
    },

    getPublicUrl(path) {
      const { data } = from().getPublicUrl(path);
      if (!data?.publicUrl) {
        failBlob("getPublicUrl", bucket, path, new Error("未返回 publicUrl"));
      }
      return data.publicUrl;
    },

    async createSignedUrl(path, expiresInSeconds) {
      const { data, error } = await from().createSignedUrl(
        path,
        expiresInSeconds,
      );
      if (error || !data?.signedUrl) {
        failBlob(
          "createSignedUrl",
          bucket,
          path,
          new Error(error?.message ?? "未返回 signedUrl"),
        );
      }
      return data.signedUrl;
    },

    async createSignedUrls(paths, expiresInSeconds) {
      if (paths.length === 0) {
        return [];
      }
      const { data, error } = await from().createSignedUrls(
        [...paths],
        expiresInSeconds,
      );
      if (error || !data) {
        failBlob(
          "createSignedUrls",
          bucket,
          paths.join(","),
          new Error(error?.message ?? "未返回数据"),
        );
      }
      return data.map((entry) => ({
        path: entry.path ?? "",
        signedUrl: entry.signedUrl ?? null,
      }));
    },

    async download(path) {
      const { data, error } = await from().download(path);
      if (error || !data) {
        failBlob(
          "download",
          bucket,
          path,
          new Error(error?.message ?? "未返回内容"),
        );
      }
      return new Uint8Array(await data.arrayBuffer());
    },

    async copy(fromPath, toPath) {
      const { error } = await from().copy(fromPath, toPath);
      if (error) {
        failBlob("copy", bucket, fromPath, new Error(error.message));
      }
    },

    async remove(paths) {
      if (paths.length === 0) {
        return;
      }
      const { error } = await from().remove([...paths]);
      if (error) {
        failBlob("remove", bucket, paths.join(","), new Error(error.message));
      }
    },
  };
}
