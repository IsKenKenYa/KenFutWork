import {
  type BlobBucket,
  type BlobNamespaceRegistration,
  type BlobOperation,
  type BlobStore,
  failBlob,
  SIGNED_URL_EXPIRY_SECONDS,
} from "./types.js";

/** 只负责typed命名空间分派，真实归属/文件路径由注册Provider验证。 */
export function createNamespacedBlobStore(
  fallback: Pick<BlobStore, "bucket">,
): BlobStore {
  const registrations = new Map<string, BlobNamespaceRegistration>();
  const key = (bucket: string, namespace: string) =>
    JSON.stringify([bucket, namespace]);
  const resolveNamespace = (bucket: string, path: string) => {
    const parts = path.replace(/^\/+/, "").split("/");
    if (
      path.includes("\\") ||
      path.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("对象路径包含非法段。");
    const registration = registrations.get(key(bucket, parts[1] ?? "")) ?? null;
    if (
      registration &&
      (path.startsWith("/") ||
        parts.length < 3 ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[0] ?? ""))
    )
      throw new Error("命名空间对象缺少有效实例或对象身份。");
    return registration;
  };
  return {
    registerNamespace(registration) {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/u.test(registration.bucket) ||
        !/^[A-Za-z0-9_-]{1,64}$/u.test(registration.namespace)
      )
        throw new Error("Blob命名空间名称无效。");
      const id = key(registration.bucket, registration.namespace);
      if (registrations.has(id)) throw new Error("Blob命名空间已注册。");
      registrations.set(id, Object.freeze({ ...registration }));
    },
    resolveNamespace,
    bucket(name) {
      const base = fallback.bucket(name);
      const route = (path: string, operation: BlobOperation) => {
        try {
          return resolveNamespace(name, path);
        } catch (error) {
          return failBlob(operation, name, path, error);
        }
      };
      const handle: BlobBucket = {
        isPublic: () => base.isPublic(),
        async resolveUrl(path, expiry) {
          const namespace = route(path, "createSignedUrl");
          if (!namespace) return base.resolveUrl(path, expiry);
          return namespace.publicRead
            ? Promise.resolve(base.getPublicUrl(path))
            : base.createSignedUrl(path, expiry ?? SIGNED_URL_EXPIRY_SECONDS);
        },
        getPublicUrl(path) {
          if (route(path, "getPublicUrl")?.publicRead === false)
            failBlob("getPublicUrl", name, path, "此命名空间需要签名URL。");
          return base.getPublicUrl(path);
        },
        createSignedUrl: async (path, expiry) => {
          route(path, "createSignedUrl");
          return base.createSignedUrl(path, expiry);
        },
        createSignedUrls: (paths, expiry) =>
          Promise.all(
            paths.map(async (path) => {
              try {
                return {
                  path,
                  signedUrl: await handle.createSignedUrl(path, expiry),
                };
              } catch {
                return { path, signedUrl: null };
              }
            }),
          ),
        upload: async (path, body, options) =>
          (route(path, "upload")?.provider ?? base).upload(path, body, options),
        download: async (path, options) =>
          (route(path, "download")?.provider ?? base).download(path, options),
        async copy(from, to) {
          const source = route(from, "copy");
          const target = route(to, "copy");
          if (source !== target)
            failBlob(
              "copy",
              name,
              from,
              "不能跨Blob命名空间复制，请使用受控资产迁移。",
            );
          await (source?.provider ?? base).copy(from, to);
        },
        remove: async (paths) =>
          Promise.all(
            paths.map((path) =>
              (route(path, "remove")?.provider ?? base).remove([path]),
            ),
          ).then(() => {}),
      };
      return handle;
    },
  };
}
