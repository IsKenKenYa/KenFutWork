import type { PersistenceService } from "../persistence/types.js";

export type AssetRecord = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  /** `bigint` 列经驱动回来是字符串，统一归一为 number 以匹配契约。 */
  byte_size: number | null;
  instance_id: string;
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
  /** `created_by_client_id` 可空：worker/executor 路径无接入客户端身份（生成物元数据）。 */
  createdByClientId?: string | null | undefined;
  instanceId: string;
};

/**
 * uploads 聚合的数据访问（`asset_objects`，带 `instance_id`）。
 * 对象存储本身走 blob 缝（M3 起），本 repository 只管元数据。
 */
export interface UploadRepository {
  /** 删除元数据行；返回受影响行数。 */
  deleteById(instanceId: string, assetId: string): Promise<number>;
  /** 取对象位置（bucket + path），用于签发 URL 或删除对象。 */
  findLocation(
    instanceId: string,
    assetId: string,
  ): Promise<AssetLocation | null>;
  insert(input: NewAssetInput): Promise<AssetRecord | null>;
}

const ASSET_COLUMNS =
  "id, bucket, object_path, mime_type, byte_size, instance_id, project_id, created_at";

type RawAssetRow = {
  id: string;
  bucket: string;
  object_path: string;
  mime_type: string | null;
  byte_size: string | number | null;
  instance_id: string;
  project_id: string | null;
  created_at: string;
};

export function createUploadRepository(
  persistence: PersistenceService,
): UploadRepository {
  return {
    async insert(input) {
      const row = await persistence
        .forInstance(input.instanceId)
        .queryOne<RawAssetRow>(
          `insert into public.asset_objects
                  (instance_id, bucket, object_path, mime_type, byte_size, created_by_client_id, project_id)
           select :instance, $1, $2, $3, $4, $5::uuid, $6::uuid
           where $6::uuid is null or exists (select 1 from public.projects p where p.id = $6::uuid and p.instance_id = :instance)
           returning ${ASSET_COLUMNS}`,
          [
            input.bucket,
            input.objectPath,
            input.mimeType,
            input.byteSize,
            input.createdByClientId ?? null,
            input.projectId ?? null,
          ],
        );

      return row ? mapAsset(row) : null;
    },

    async findLocation(instanceId, assetId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<AssetLocation>(
          `select bucket, object_path
             from public.asset_objects
            where instance_id = :instance
              and id = $1`,
          [assetId],
        );
      return row ?? null;
    },

    async deleteById(instanceId, assetId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.asset_objects
          where instance_id = :instance
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
    instance_id: row.instance_id,
  };
}
