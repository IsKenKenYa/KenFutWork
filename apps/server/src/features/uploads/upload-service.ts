import type { AssetBucket, AssetObject } from "@loomic/shared";

import type {
  AuthenticatedUser,
  UserSupabaseClient,
} from "../../supabase/user.js";
import type { ViewerService } from "../bootstrap/ensure-user-foundation.js";
import type { UploadRepository } from "./repository.js";

/** Buckets configured as public in Supabase — use getPublicUrl instead of signed URLs */
const PUBLIC_BUCKETS = new Set(["project-assets"]);

const SIGNED_URL_EXPIRY_SECONDS = 3600;
const UPLOAD_FAILED_MESSAGE = "Unable to upload asset.";
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
    user: AuthenticatedUser,
    input: UploadFileInput,
  ): Promise<{ asset: AssetObject; url: string }>;

  getAssetUrl(user: AuthenticatedUser, assetId: string): Promise<string>;

  deleteAsset(user: AuthenticatedUser, assetId: string): Promise<void>;
};

export function createUploadService(options: {
  /** 对象存储仍走 Supabase Storage（M3 blob 缝收口后移除）。 */
  createUserClient: (accessToken: string) => UserSupabaseClient;
  repository: UploadRepository;
  viewerService: ViewerService;
}): UploadService {
  const { repository, viewerService } = options;

  const resolveWorkspaceId = async (user: AuthenticatedUser) => {
    const workspace = await viewerService
      .resolveWorkspace(user)
      .catch(() => null);

    if (!workspace) {
      throw new UploadServiceError("upload_failed", UPLOAD_FAILED_MESSAGE, 500);
    }

    return workspace.id;
  };

  return {
    async uploadFile(user, input) {
      const workspaceId = await resolveWorkspaceId(user);
      const client = options.createUserClient(user.accessToken);
      const objectPath = buildObjectPath(
        workspaceId,
        input.projectId,
        input.fileName,
      );

      const { error: storageError } = await client.storage
        .from(input.bucket)
        .upload(objectPath, input.fileBuffer, {
          contentType: input.mimeType,
          upsert: false,
        });

      if (storageError) {
        throw new UploadServiceError(
          "upload_failed",
          `Storage upload failed: ${storageError.message}`,
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
          userId: user.id,
          workspaceId,
        })
        .catch(() => null);

      if (!assetRow) {
        // 元数据落库失败时清掉已上传对象，避免孤儿文件。
        await client.storage.from(input.bucket).remove([objectPath]);
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
          workspaceId: assetRow.workspace_id,
          projectId: assetRow.project_id,
          createdAt: assetRow.created_at,
        },
        url: await getAssetUrl(client, input.bucket, objectPath),
      };
    },

    async getAssetUrl(user, assetId) {
      const workspaceId = await resolveWorkspaceId(user);
      const client = options.createUserClient(user.accessToken);
      const location = await repository
        .findLocation(workspaceId, assetId)
        .catch(() => null);

      if (!location) {
        throw new UploadServiceError(
          "asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      return getAssetUrl(client, location.bucket, location.object_path);
    },

    async deleteAsset(user, assetId) {
      const workspaceId = await resolveWorkspaceId(user);
      const client = options.createUserClient(user.accessToken);
      const location = await repository
        .findLocation(workspaceId, assetId)
        .catch(() => null);

      if (!location) {
        throw new UploadServiceError(
          "asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      await client.storage.from(location.bucket).remove([location.object_path]);

      const deleted = await repository
        .deleteById(workspaceId, assetId)
        .catch(() => 0);

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
  workspaceId: string,
  projectId: string | undefined,
  fileName: string,
): string {
  const timestamp = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (projectId) {
    return `${workspaceId}/${projectId}/${timestamp}-${safeName}`;
  }
  return `${workspaceId}/${timestamp}-${safeName}`;
}

async function getAssetUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  if (PUBLIC_BUCKETS.has(bucket)) {
    const { data } = client.storage.from(bucket).getPublicUrl(objectPath);
    return data.publicUrl;
  }
  // Fallback for private buckets (e.g. user-avatars)
  return createSignedUrl(client, bucket, objectPath);
}

async function createSignedUrl(
  client: UserSupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<string> {
  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(objectPath, SIGNED_URL_EXPIRY_SECONDS);

  if (error || !data?.signedUrl) {
    throw new UploadServiceError(
      "upload_failed",
      "Failed to generate signed URL.",
      500,
    );
  }

  return data.signedUrl;
}
