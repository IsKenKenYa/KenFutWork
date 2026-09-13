import type { PersistenceService } from "../persistence/types.js";

export type AssetRecord = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  /** `bigint` 列经驱动回来是字符串，统一归一为 number 以匹配契约。 */
  byte_size: number | null;
  workspace_id: string;
  project_id: string | null;
  created_at: string;
};

export type AssetLocation = {
  bucket: string;
  object_path: string;
};

export type NewAssetInput = {
  bucket: string;
  byteSize: number;
  mimeType: string;
  objectPath: string;
  projectId?: string | undefined;
  userId: string;
  workspaceId: string;
};

/**
 * uploads 聚合的数据访问（`asset_objects`，带 `workspace_id`）。
 * 对象存储本身走 blob 缝（M3 起），本 repository 只管元数据。
 */
export interface UploadRepository {
  /** 删除元数据行；返回受影响行数。 */
  deleteById(workspaceId: string, assetId: string): Promise<number>;
  /** 取对象位置（bucket + path），用于签发 URL 或删除对象。 */
  findLocation(
    workspaceId: string,
    assetId: string,
  ): Promise<AssetLocation | null>;
  insert(input: NewAssetInput): Promise<AssetRecord | null>;
}

const ASSET_COLUMNS =
  "id, bucket, object_path, mime_type, byte_size, workspace_id, project_id, created_at";

type RawAssetRow = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: string | number | null;
  workspace_id: string;
  project_id: string | null;
  created_at: string;
};

export function createUploadRepository(
  persistence: PersistenceService,
): UploadRepository {
  return {
    async insert(input) {
      const row = await persistence
        .forWorkspace(input.workspaceId)
        .queryOne<RawAssetRow>(
          `insert into public.asset_objects
                  (workspace_id, bucket, object_path, mime_type, byte_size, created_by, project_id)
           values (:workspace, $1, $2, $3, $4, $5, $6)
           returning ${ASSET_COLUMNS}`,
          [
            input.bucket,
            input.objectPath,
            input.mimeType,
            input.byteSize,
            input.userId,
            input.projectId ?? null,
          ],
        );

      return row ? mapAsset(row) : null;
    },

    async findLocation(workspaceId, assetId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<AssetLocation>(
          `select bucket, object_path
             from public.asset_objects
            where workspace_id = :workspace
              and id = $1`,
          [assetId],
        );
      return row ?? null;
    },

    async deleteById(workspaceId, assetId) {
      return persistence.forWorkspace(workspaceId).execute(
        `delete from public.asset_objects
          where workspace_id = :workspace
            and id = $1`,
        [assetId],
      );
    },
  };
}

function mapAsset(row: RawAssetRow): AssetRecord {
  return {
    bucket: row.bucket,
    byte_size: row.byte_size === null ? null : Number(row.byte_size),
    created_at: row.created_at,
    id: row.id,
    mime_type: row.mime_type,
    object_path: row.object_path,
    project_id: row.project_id,
    workspace_id: row.workspace_id,
  };
}
