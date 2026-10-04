import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

import {
  type BlobBucket,
  type BlobOperation,
  type BlobStore,
  failBlob,
  LOCAL_PUBLIC_BUCKETS,
  SIGNED_URL_EXPIRY_SECONDS,
} from "../types.js";

/**
 * blob 缝的**桌面 Provider**：本地文件系统（FORM-2 的「本地 blob」）。
 *
 * 目录布局 `<root>/<bucket>/<path>`；`getPublicUrl` 指向 server 自己的读取路由
 * （`<base>/<bucket>/<path>`），签名 URL 用 HMAC（`?exp=<ts>&sig=<hex>`），与 Supabase
 * 的时效语义一致，故消费方不必分形态写两套。
 *
 * 路径一律**规范化 + 前缀校验**：拒绝 `..` 逃逸出 root——对象路径虽由服务端拼装，但
 * 其中的 `fileName` 含客户端输入，越界写会把本地文件系统暴露给上传者。
 */
export function createLocalFsBlobStore(options: {
  rootDir: string;
  publicBaseUrl: string;
  signingSecret: string;
}): BlobStore {
  const root = resolve(options.rootDir);

  return {
    bucket(name) {
      return createBucket({
        bucket: name,
        publicBaseUrl: options.publicBaseUrl.replace(/\/+$/, ""),
        root,
        signingSecret: options.signingSecret,
      });
    },
  };
}

/** 把对象路径解析为绝对路径；越界即抛（段级拒绝 `..`/`.` + 前缀校验）。 */
export function resolveBlobPath(
  root: string,
  bucket: string,
  path: string,
): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    throw new Error(`对象路径含非法段：${path}`);
  }
  const absolute = normalize(join(resolve(root), bucket, ...segments));
  const prefix = `${resolve(root)}${sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new Error(`对象路径越界：${path}`);
  }
  return absolute;
}

/** 签名体的构造与校验共用一处（路由侧复用 `verifyBlobUrlSignature`）。 */
export function signBlobUrl(input: {
  bucket: string;
  expiresAt: number;
  path: string;
  signingSecret: string;
}): string {
  return createHmac("sha256", input.signingSecret)
    .update(`${input.bucket}\n${input.path}\n${input.expiresAt}`)
    .digest("hex");
}

/** 校验签名 URL：签名匹配且未过期。 */
export function verifyBlobUrlSignature(input: {
  bucket: string;
  expiresAt: number;
  path: string;
  signature: string;
  signingSecret: string;
}): boolean {
  if (
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt * 1000 < Date.now()
  ) {
    return false;
  }
  const expected = Buffer.from(signBlobUrl(input), "utf8");
  const given = Buffer.from(input.signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Bounded consumers verify object size before allocation and reject a file changed during the read. */
async function readBoundedBlob(
  path: string,
  maximum: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 0)
    throw new Error("对象读取预算无效。");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maximum)
      throw new Error("对象不是常规文件或超过读取预算。");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) throw new Error("对象在读取期间被截断。");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("对象在读取期间改变。");
    return bytes;
  } finally {
    await file.close();
  }
}

function createBucket(options: {
  bucket: string;
  publicBaseUrl: string;
  root: string;
  signingSecret: string;
}): BlobBucket {
  const { bucket, publicBaseUrl, root, signingSecret } = options;

  const absoluteOf = (operation: BlobOperation, path: string): string => {
    try {
      return resolveBlobPath(root, bucket, path);
    } catch (error) {
      failBlob(operation, bucket, path, error);
    }
  };

  const urlOf = (path: string): string =>
    `${publicBaseUrl}/${bucket}/${path.replace(/^\/+/, "")}`;

  return {
    async isPublic() {
      // 桌面单用户形态没有存储侧策略可查，公开性由这份本地约定决定
      return LOCAL_PUBLIC_BUCKETS.has(bucket);
    },

    async resolveUrl(path, expiresInSeconds) {
      if (LOCAL_PUBLIC_BUCKETS.has(bucket)) {
        return urlOf(path);
      }
      return this.createSignedUrl(
        path,
        expiresInSeconds ?? SIGNED_URL_EXPIRY_SECONDS,
      );
    },

    async upload(path, body, uploadOptions) {
      const target = absoluteOf("upload", path);
      try {
        await mkdir(dirname(target), { recursive: true });
        if (!uploadOptions?.upsert) {
          // 与 Supabase `upsert: false` 同义：已存在即失败，不静默覆盖
          const exists = await readFile(target).then(
            () => true,
            () => false,
          );
          if (exists) {
            throw new Error("对象已存在且 upsert=false");
          }
        }
        await writeFile(target, body);
      } catch (error) {
        failBlob("upload", bucket, path, error);
      }
    },

    getPublicUrl(path) {
      return urlOf(path);
    },

    async createSignedUrl(path, expiresInSeconds) {
      const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
      const signature = signBlobUrl({
        bucket,
        expiresAt,
        path,
        signingSecret,
      });
      return `${urlOf(path)}?exp=${expiresAt}&sig=${signature}`;
    },

    async createSignedUrls(paths, expiresInSeconds) {
      // 逐条独立成败（与 Supabase 同形）
      return Promise.all(
        paths.map(async (path) => {
          try {
            const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
            const signature = signBlobUrl({
              bucket,
              expiresAt,
              path,
              signingSecret,
            });
            return {
              path,
              signedUrl: `${urlOf(path)}?exp=${expiresAt}&sig=${signature}`,
            };
          } catch {
            return { path, signedUrl: null };
          }
        }),
      );
    },

    async download(path, readOptions) {
      const target = absoluteOf("download", path);
      try {
        return readOptions
          ? await readBoundedBlob(target, readOptions.maxBytes)
          : new Uint8Array(await readFile(target));
      } catch (error) {
        failBlob("download", bucket, path, error);
      }
    },

    async copy(fromPath, toPath) {
      const target = absoluteOf("copy", toPath);
      try {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(absoluteOf("copy", fromPath), target);
      } catch (error) {
        failBlob("copy", bucket, fromPath, error);
      }
    },

    async remove(paths) {
      // 幂等：不存在的路径不报错
      await Promise.all(
        paths.map((path) => rm(absoluteOf("remove", path), { force: true })),
      );
    },
  };
}
