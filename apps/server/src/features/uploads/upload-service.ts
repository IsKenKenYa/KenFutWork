import type { AssetBucket, AssetObject } from "@kenfutwork/shared";
import type { BlobStore } from "../blob/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type { UploadRepository } from "./repository.js";

const ASSET_NOT_FOUND_MESSAGE = "Asset not found.";

export class UploadServiceError extends Error {
  readonly statusCode: number;
  readonly code: "upload_failed" | "asset_not_found";

  constructor(
    code: "upload_failed" | "asset_not_found",
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "UploadServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 工作区由服务端解析（`FORM-9`），故不由调用方传入。 */
export type UploadFileInput = {
  bucket: AssetBucket;
  fileName: string;
  fileBuffer: Buffer;
  mimeType: string;
  projectId?: string | undefined;
};

export type UploadService = {
  uploadFile(
    actor: LocalActor,
    input: UploadFileInput,
  ): Promise<{ asset: AssetObject; url: string }>;

  getAssetUrl(actor: LocalActor, assetId: string): Promise<string>;

  deleteAsset(actor: LocalActor, assetId: string): Promise<void>;
};

export function createUploadService(options: {
  /** 对象存储走 blob 缝（Provider 随形态替换）。 */
  blob: BlobStore;
  repository: UploadRepository;
  localInstance: LocalInstanceService;
}): UploadService {
  const { blob, repository, localInstance } = options;

  const resolveId = async (actor: LocalActor) =>
    (await localInstance.resolve(actor)).instanceId;

  return {
    async uploadFile(actor, input) {
      const instanceId = await resolveId(actor);
      const bucket = blob.bucket(input.bucket);
      const objectPath = buildObjectPath(
        instanceId,
        input.projectId,
        input.fileName,
      );

      try {
        await bucket.upload(objectPath, input.fileBuffer, {
          contentType: input.mimeType,
          upsert: false,
        });
      } catch (error) {
        throw new UploadServiceError(
          "upload_failed",
          `Upload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          500,
        );
      }

      const assetRow = await repository
        .insert({
          bucket: input.bucket,
          byteSize: input.fileBuffer.length,
          mimeType: input.mimeType,
          objectPath,
          projectId: input.projectId,
          createdByClientId: actor.accessClientId,
          instanceId,
        })
        .catch(() => null);

      if (!assetRow) {
        // 元数据落库失败时清掉已上传对象，避免孤儿文件。
        await bucket.remove([objectPath]);
        throw new UploadServiceError(
          "upload_failed",
          "Failed to record asset metadata.",
          500,
        );
      }

      return {
        asset: {
          id: assetRow.id,
          bucket: assetRow.bucket as AssetBucket,
          objectPath: assetRow.object_path,
          mimeType: assetRow.mime_type,
          byteSize: assetRow.byte_size,
          instanceId: assetRow.instance_id,
          projectId: assetRow.project_id,
          createdAt: assetRow.created_at,
        },
        url: await resolveAssetUrl(blob, input.bucket, objectPath),
      };
    },

    async getAssetUrl(actor, assetId) {
      const instanceId = await resolveId(actor);
      const location = await repository.findLocation(instanceId, assetId);

      if (!location) {
        throw new UploadServiceError(
          "asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      return resolveAssetUrl(blob, location.bucket, location.object_path);
    },

    async deleteAsset(actor, assetId) {
      const instanceId = await resolveId(actor);
      const location = await repository.findLocation(instanceId, assetId);

      if (!location) {
        throw new UploadServiceError(
          "asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      await blob.bucket(location.bucket).remove([location.object_path]);

      const deleted = await repository.deleteById(instanceId, assetId);

      if (deleted === 0) {
        throw new UploadServiceError(
          "asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }
    },
  };
}

function buildObjectPath(
  instanceId: string,
  projectId: string | undefined,
  fileName: string,
): string {
  const timestamp = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (projectId) {
    return `${instanceId}/${projectId}/${timestamp}-${safeName}`;
  }
  return `${instanceId}/${timestamp}-${safeName}`;
}

/**
 * 资产 URL 交给 blob 缝的 `resolveUrl`：**公开性由存储侧回答**，不在业务代码里
 * 硬编码公开桶清单——实测 `project-assets` 的 public 标志在本地库里为 false，
 * 硬编码会产出 400 死链（见 `features/blob/types.ts` 的 isPublic 注释）。
 */
async function resolveAssetUrl(
  blob: BlobStore,
  bucket: string,
  objectPath: string,
): Promise<string> {
  try {
    return await blob.bucket(bucket).resolveUrl(objectPath);
  } catch (error) {
    throw new UploadServiceError(
      "upload_failed",
      `Failed to generate asset URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }
}
