/**
 * blob 缝的 Service Definition（§4.2 / M3.1）。
 *
 * 对象存储的**唯一入口**：消费方（uploads / brand-kit / canvas / projects / agent 运行时 /
 * 生成 executor）只依赖本接口，不再直接触达 Supabase Storage 或任何具体实现。
 *
 * **只有一个作用域（系统）**：按 `FORM-9`，隔离由应用层承担——对象路径一律以
 * `workspaceId/`（或个人 `userId/`）开头，由调用方在服务端拼好且不接受客户端传入；
 * 存储侧不再依赖 RLS 判定（存量实现是用户 token + storage 策略）。这样 blob 缝天然
 * 适配桌面（无令牌）与自托管，不必把「用户令牌」这一 Supabase 概念渗进接口。
 *
 * 桶名不是契约的一部分（Provider 自行解释）；`bucket()` 只做命名空间分组。
 */

/** 错误统一折叠成 BlobError（消费方按 `operation` 判因，不依赖驱动错误形状）。 */
export class BlobError extends Error {
  readonly bucket: string;
  readonly operation: BlobOperation;
  readonly path: string;

  constructor(
    operation: BlobOperation,
    bucket: string,
    path: string,
    message: string,
  ) {
    super(
      `[blob] ${operation} 失败（bucket=${bucket} path=${path}）：${message}`,
    );
    this.name = "BlobError";
    this.bucket = bucket;
    this.operation = operation;
    this.path = path;
  }
}

/** Provider 侧统一的失败出口：抛 BlobError，且返回类型为 `never`（便于控制流收窄）。 */
export function failBlob(
  operation: BlobOperation,
  bucket: string,
  path: string,
  error: unknown,
): never {
  throw new BlobError(
    operation,
    bucket,
    path,
    error instanceof Error ? error.message : String(error),
  );
}

export type BlobOperation =
  | "copy"
  | "createSignedUrl"
  | "createSignedUrls"
  | "download"
  | "getPublicUrl"
  | "remove"
  | "upload";

export type BlobUploadOptions = {
  contentType?: string | undefined;
  /** 覆盖同路径已有对象（默认 false，与 Supabase `upsert` 同义）。 */
  upsert?: boolean | undefined;
};

export type SignedUrlEntry = {
  path: string;
  signedUrl: string | null;
};

/** 单桶句柄：方法与存量调用点一一对应，便于逐处替换。 */
export type BlobBucket = {
  /**
   * 桶是否公开可读。**消费方不应硬编码公开桶清单**——实际公开性由存储侧决定
   * （迁移声明 public=true 也可能因环境状态不一致而未生效，实测踩过：
   * `project-assets` 在本地库里 public=false，公网路由会把非公开桶报成
   * 「Bucket not found」，于是硬编码假设会产出 400 的死链）。
   */
  isPublic(): Promise<boolean>;
  /**
   * 取**可直接访问**的 URL：公开桶给稳定公网 URL，非公开桶给时效签名 URL。
   * 消费方一律用它，不必自己判公开性。
   */
  resolveUrl(path: string, expiresInSeconds?: number): Promise<string>;
  /** 写入对象。 */
  upload(
    path: string,
    body: Uint8Array,
    options?: BlobUploadOptions,
  ): Promise<void>;
  /** 公开可读 URL（同步，与 Supabase `getPublicUrl` 同形）。 */
  getPublicUrl(path: string): string;
  /** 时效签名 URL。 */
  createSignedUrl(path: string, expiresInSeconds: number): Promise<string>;
  /** 批量签名；逐条独立成败（与 Supabase 同形，失败项 `signedUrl: null`）。 */
  createSignedUrls(
    paths: readonly string[],
    expiresInSeconds: number,
  ): Promise<SignedUrlEntry[]>;
  /** 读回对象内容。 */
  download(path: string): Promise<Uint8Array>;
  /** 桶内复制（源与目标同桶）。 */
  copy(fromPath: string, toPath: string): Promise<void>;
  /** 删除对象；不存在的路径不报错（幂等）。 */
  remove(paths: readonly string[]): Promise<void>;
};

export type BlobStore = {
  bucket(name: string): BlobBucket;
};

/**
 * 本地 FS 形态下视为公开可读的桶（桌面单用户，等价于「直接给 URL」）。
 * 仅 `local-fs` Provider 使用；Supabase 形态由存储侧查询真实公开性。
 */
export const LOCAL_PUBLIC_BUCKETS: ReadonlySet<string> = new Set([
  "project-assets",
  "brand-kit-assets",
]);

export const SIGNED_URL_EXPIRY_SECONDS = 3600;
