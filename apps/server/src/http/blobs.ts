import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { FastifyInstance } from "fastify";

import {
  resolveBlobPath,
  verifyBlobUrlSignature,
} from "../features/blob/providers/local-fs.js";
import { LOCAL_PUBLIC_BUCKETS } from "../features/blob/types.js";

/**
 * 本地 blob 读取路由（仅 `KENFUTWORK_BLOB_DRIVER=local` 时挂载）。
 *
 * 桌面单用户形态下，`getPublicUrl` 指向这里；公开桶直接放行，非公开桶要求有效签名
 * （`?exp=<秒>&sig=<hmac>`）——签名由 `local-fs` Provider 生成，密钥是
 * `KENFUTWORK_CREDENTIAL_SECRET`，与上传侧同源。
 *
 * 路径经 `resolveBlobPath` 规范化并做前缀校验：拒绝 `..` 逃逸出对象根目录
 * （`bucket`/`path` 都来自 URL，属外部输入）。
 */
const CONTENT_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export async function registerBlobRoutes(
  app: FastifyInstance,
  options: {
    rootDir: string;
    signingSecret: string;
  },
): Promise<void> {
  app.get("/api/blobs/:bucket/*", async (request, reply) => {
    const { bucket } = request.params as { bucket: string };
    const objectPath = (request.params as Record<string, string>)["*"] ?? "";

    if (!LOCAL_PUBLIC_BUCKETS.has(bucket)) {
      const query = request.query as Record<string, string>;
      const authorized = verifyBlobUrlSignature({
        bucket,
        expiresAt: Number(query.exp),
        path: objectPath,
        signature: query.sig ?? "",
        signingSecret: options.signingSecret,
      });
      if (!authorized) {
        return reply.code(403).send({ error: "Invalid or expired signature." });
      }
    }

    let absolute: string;
    try {
      absolute = resolveBlobPath(options.rootDir, bucket, objectPath);
    } catch {
      // 越界路径按「不存在」处理：不回显内部路径信息
      return reply.code(404).send({ error: "Object not found." });
    }

    try {
      const body = await readFile(absolute);
      return reply
        .header(
          "content-type",
          CONTENT_TYPES[extname(absolute).toLowerCase()] ??
            "application/octet-stream",
        )
        .send(body);
    } catch {
      return reply.code(404).send({ error: "Object not found." });
    }
  });
}
