import type { UploadRepository } from "./repository.js";

export class AssetWriterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetWriterError";
  }
}

export type GeneratedAssetInput = {
  byteSize: number;
  mimeType: string;
  objectPath: string;
  /** 触发本次生成的用户；无身份时省略（`asset_objects.created_by` 可空）。 */
  userId?: string | undefined;
  /** 工作区 id 来自任务记录——executor 无用户身份，故只能按工作区定权写入。 */
  workspaceId: string;
};

/**
 * 生成物元数据写入缝（worker/executor 路径）。
 *
 * 与 `UploadService` 的分工：HTTP 上传的身份来自鉴权用户、工作区由 viewer 解析；
 * executor 无用户身份、也无 viewer，只能按**任务记录里的工作区**写入。两者同写
 * `asset_objects`，故共用同一个 `UploadRepository`（隔离谓词也同一条）。
 * 对象存储本身走 blob 缝（M3），本缝只管元数据行。
 */
export type AssetWriter = {
  /** 写生成物元数据；返回新行 id。写失败抛错（不静默）。 */
  recordGeneratedAsset(input: GeneratedAssetInput): Promise<string>;
};

export function createAssetWriter(repository: UploadRepository): AssetWriter {
  return {
    async recordGeneratedAsset(input) {
      const asset = await repository.insert({
        bucket: "project-assets",
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        objectPath: input.objectPath,
        ...(input.userId ? { userId: input.userId } : {}),
        workspaceId: input.workspaceId,
      });

      if (!asset) {
        throw new AssetWriterError("Asset insert returned no row.");
      }

      return asset.id;
    },
  };
}
