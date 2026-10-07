import type {
  BrandKitAsset,
  BrandKitAssetCreateRequest,
  BrandKitAssetUpdateRequest,
  BrandKitCreateRequest,
  BrandKitDetail,
  BrandKitSummary,
  BrandKitUpdateRequest,
} from "@kenfutwork/shared";
import type { BlobStore } from "../blob/types.js";
import type {
  LocalActor,
  LocalInstanceService,
} from "../local-instance/types.js";
import type {
  BrandKitAssetPatch,
  BrandKitAssetRow,
  BrandKitPatch,
  BrandKitRepository,
  BrandKitRow,
} from "./repository.js";

const BRAND_KIT_BUCKET = "brand-kit-assets";
const SIGNED_URL_EXPIRY_SECONDS = 3600;

const KIT_NOT_FOUND_MESSAGE = "Brand kit not found.";
const KIT_CREATE_FAILED_MESSAGE = "Unable to create brand kit.";
const KIT_UPDATE_FAILED_MESSAGE = "Unable to update brand kit.";
const KIT_DELETE_FAILED_MESSAGE = "Unable to delete brand kit.";
const KIT_QUERY_FAILED_MESSAGE = "Unable to load brand kits.";
const ASSET_NOT_FOUND_MESSAGE = "Brand kit asset not found.";
const ASSET_CREATE_FAILED_MESSAGE = "Unable to create brand kit asset.";

type BrandKitServiceErrorCode =
  | "brand_kit_not_found"
  | "brand_kit_create_failed"
  | "brand_kit_update_failed"
  | "brand_kit_delete_failed"
  | "brand_kit_query_failed"
  | "brand_kit_asset_not_found"
  | "brand_kit_asset_create_failed";

export class BrandKitServiceError extends Error {
  readonly statusCode: number;
  readonly code: BrandKitServiceErrorCode;

  constructor(
    code: BrandKitServiceErrorCode,
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "BrandKitServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type BrandKitService = {
  listKits(actor: LocalActor): Promise<BrandKitSummary[]>;
  getKit(actor: LocalActor, kitId: string): Promise<BrandKitDetail>;
  createKit(
    actor: LocalActor,
    input: BrandKitCreateRequest,
  ): Promise<BrandKitDetail>;
  updateKit(
    actor: LocalActor,
    kitId: string,
    input: BrandKitUpdateRequest,
  ): Promise<BrandKitDetail>;
  deleteKit(actor: LocalActor, kitId: string): Promise<void>;
  createAsset(
    actor: LocalActor,
    kitId: string,
    input: BrandKitAssetCreateRequest,
  ): Promise<BrandKitAsset>;
  updateAsset(
    actor: LocalActor,
    kitId: string,
    assetId: string,
    input: BrandKitAssetUpdateRequest,
  ): Promise<BrandKitAsset>;
  deleteAsset(actor: LocalActor, kitId: string, assetId: string): Promise<void>;
  uploadAsset(
    actor: LocalActor,
    kitId: string,
    assetType: "logo" | "image",
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
  ): Promise<BrandKitAsset>;
  duplicateKit(actor: LocalActor, kitId: string): Promise<BrandKitDetail>;
};

/**
 * brand-kit 服务。数据访问经 repository（`brand_kits` 按 `instance_id` 定权、
 * `brand_kit_assets` 经父链校验归属）；对象存储经 `blob` 缝，
 * 随 M3 blob 缝落地移除。
 */
export function createBrandKitService(options: {
  /** 对象存储走 blob 缝（本聚合的桶非公开 → 用签名 URL）。 */
  blob: BlobStore;
  repository: BrandKitRepository;
  localInstance: LocalInstanceService;
}): BrandKitService {
  const { repository } = options;

  async function fetchKitDetail(
    actor: LocalActor,
    kitId: string,
  ): Promise<BrandKitDetail> {
    await options.localInstance.resolve(actor);
    let kit: BrandKitRow | null;
    try {
      kit = await repository.findKit(actor.instanceId, kitId);
    } catch {
      throw new BrandKitServiceError(
        "brand_kit_not_found",
        KIT_NOT_FOUND_MESSAGE,
        500,
      );
    }

    if (!kit) {
      throw new BrandKitServiceError(
        "brand_kit_not_found",
        KIT_NOT_FOUND_MESSAGE,
        404,
      );
    }

    let assetRows: BrandKitAssetRow[];
    try {
      assetRows = await repository.listAssets(actor.instanceId, kitId);
    } catch {
      throw new BrandKitServiceError(
        "brand_kit_query_failed",
        KIT_QUERY_FAILED_MESSAGE,
        500,
      );
    }

    const mappedAssets = assetRows.map(mapAssetRow);

    // Resolve signed URLs for file-based assets (logo/image)
    // 谓词形式让 file_url 在后续循环里保持非空收窄（普通 filter 不收窄）
    const fileAssets = mappedAssets.filter(
      (asset): asset is BrandKitAsset & { file_url: string } =>
        Boolean(asset.file_url),
    );
    if (fileAssets.length > 0) {
      const paths = fileAssets.map((a) => a.file_url);
      const signedEntries = await options.blob
        .bucket(BRAND_KIT_BUCKET)
        .createSignedUrls(paths, SIGNED_URL_EXPIRY_SECONDS);

      if (signedEntries.length > 0) {
        const urlByPath = new Map<string, string>(
          signedEntries.flatMap((entry) =>
            entry.signedUrl ? [[entry.path, entry.signedUrl] as const] : [],
          ),
        );
        for (const asset of fileAssets) {
          const url = urlByPath.get(asset.file_url);
          if (url) asset.file_url = url;
        }
      }
    }

    return {
      id: kit.id,
      name: kit.name,
      is_default: kit.is_default,
      guidance_text: kit.guidance_text,
      cover_url: kit.cover_url,
      assets: mappedAssets,
      created_at: kit.created_at,
      updated_at: kit.updated_at,
    };
  }

  return {
    async listKits(actor) {
      await options.localInstance.resolve(actor);
      let kits: Awaited<ReturnType<typeof repository.listKits>>;
      try {
        kits = await repository.listKits(actor.instanceId);
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_query_failed",
          KIT_QUERY_FAILED_MESSAGE,
          500,
        );
      }

      if (kits.length === 0) {
        return [];
      }

      let assets: Array<{ asset_type: string; kit_id: string }>;
      try {
        assets = await repository.listAssetCounts(
          actor.instanceId,
          kits.map((k) => k.id),
        );
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_query_failed",
          KIT_QUERY_FAILED_MESSAGE,
          500,
        );
      }

      const countsByKit = new Map<
        string,
        { color: number; font: number; image: number; logo: number }
      >();

      for (const asset of assets) {
        let counts = countsByKit.get(asset.kit_id);
        if (!counts) {
          counts = { color: 0, font: 0, image: 0, logo: 0 };
          countsByKit.set(asset.kit_id, counts);
        }
        counts[asset.asset_type as "color" | "font" | "image" | "logo"] += 1;
      }

      return kits.map(
        (kit): BrandKitSummary => ({
          id: kit.id,
          name: kit.name,
          is_default: kit.is_default,
          cover_url: kit.cover_url,
          asset_counts: countsByKit.get(kit.id) ?? {
            color: 0,
            font: 0,
            image: 0,
            logo: 0,
          },
          created_at: kit.created_at,
          updated_at: kit.updated_at,
        }),
      );
    },

    async getKit(actor, kitId) {
      await options.localInstance.resolve(actor);
      return fetchKitDetail(actor, kitId);
    },

    async createKit(actor, input) {
      await options.localInstance.resolve(actor);
      const name = input.name?.trim() || "未命名";

      const kitId = await repository
        .insertKit(actor.instanceId, { name })
        .catch(() => null);

      if (!kitId) {
        throw new BrandKitServiceError(
          "brand_kit_create_failed",
          KIT_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      return fetchKitDetail(actor, kitId);
    },

    async updateKit(actor, kitId, input) {
      await options.localInstance.resolve(actor);
      // If setting as default, clear existing default first
      if (input.is_default === true) {
        await repository.clearDefault(actor.instanceId).catch(() => {
          throw new BrandKitServiceError(
            "brand_kit_update_failed",
            KIT_UPDATE_FAILED_MESSAGE,
            500,
          );
        });
      }

      const patch: BrandKitPatch = {};
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.guidance_text !== undefined) {
        patch.guidance_text = input.guidance_text;
      }
      if (input.is_default !== undefined) patch.is_default = input.is_default;

      if (Object.keys(patch).length === 0) {
        return fetchKitDetail(actor, kitId);
      }

      await repository.updateKit(actor.instanceId, kitId, patch).catch(() => {
        throw new BrandKitServiceError(
          "brand_kit_update_failed",
          KIT_UPDATE_FAILED_MESSAGE,
          500,
        );
      });

      // 未命中的判定交给后续 fetchKitDetail（与旧实现的 count 语义一致）
      return fetchKitDetail(actor, kitId);
    },

    async deleteKit(actor, kitId) {
      await options.localInstance.resolve(actor);
      let exists: string | null;
      try {
        exists = await repository.findKitRef(actor.instanceId, kitId);
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      }

      if (!exists) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Clean up storage objects for file-based assets
      const paths = await repository
        .listAssetFilePaths(actor.instanceId, kitId)
        .catch(() => []);

      if (paths.length > 0) {
        await options.blob.bucket(BRAND_KIT_BUCKET).remove(paths);
      }

      await repository.deleteKit(actor.instanceId, kitId).catch(() => {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      });
    },

    async createAsset(actor, kitId, input) {
      await options.localInstance.resolve(actor);
      // Verify kit exists（查询失败 500 / 无行 404 与旧实现一致）
      let kitId_: string | null;
      try {
        kitId_ = await repository.findKitRef(actor.instanceId, kitId);
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          500,
        );
      }

      if (!kitId_) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Get max sort_order for this kit + asset_type
      const maxSortOrder = await repository
        .maxAssetSortOrder(actor.instanceId, kitId, input.asset_type)
        .catch(() => null);

      const asset = await repository
        .insertAsset(actor.instanceId, kitId, {
          asset_type: input.asset_type,
          display_name: input.display_name,
          metadata: input.metadata ?? {},
          role: input.role ?? null,
          sort_order: (maxSortOrder ?? -1) + 1,
          text_content: input.text_content ?? null,
        })
        .catch(() => null);

      if (!asset) {
        throw new BrandKitServiceError(
          "brand_kit_asset_create_failed",
          ASSET_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      return mapAssetRow(asset);
    },

    async updateAsset(actor, kitId, assetId, input) {
      await options.localInstance.resolve(actor);
      const patch: BrandKitAssetPatch = {};
      if (input.display_name !== undefined)
        patch.display_name = input.display_name;
      if (input.text_content !== undefined)
        patch.text_content = input.text_content;
      if (input.role !== undefined) patch.role = input.role;
      if (input.sort_order !== undefined) patch.sort_order = input.sort_order;
      if (input.metadata !== undefined) patch.metadata = input.metadata;

      if (Object.keys(patch).length === 0) {
        // Nothing to update, just fetch and return current state
        let current: BrandKitAssetRow | null;
        try {
          current = await repository.findAsset(
            actor.instanceId,
            kitId,
            assetId,
          );
        } catch {
          throw new BrandKitServiceError(
            "brand_kit_asset_not_found",
            ASSET_NOT_FOUND_MESSAGE,
            500,
          );
        }

        if (!current) {
          throw new BrandKitServiceError(
            "brand_kit_asset_not_found",
            ASSET_NOT_FOUND_MESSAGE,
            404,
          );
        }

        return mapAssetRow(current);
      }

      let updated: BrandKitAssetRow | null;
      try {
        updated = await repository.updateAsset(
          actor.instanceId,
          kitId,
          assetId,
          patch,
        );
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_update_failed",
          KIT_UPDATE_FAILED_MESSAGE,
          500,
        );
      }

      if (!updated) {
        throw new BrandKitServiceError(
          "brand_kit_asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      return mapAssetRow(updated);
    },

    async deleteAsset(actor, kitId, assetId) {
      await options.localInstance.resolve(actor);
      let existing: { file_url: string | null; id: string } | null;
      try {
        existing = await repository.findAssetRef(
          actor.instanceId,
          kitId,
          assetId,
        );
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_delete_failed",
          KIT_DELETE_FAILED_MESSAGE,
          500,
        );
      }

      if (!existing) {
        throw new BrandKitServiceError(
          "brand_kit_asset_not_found",
          ASSET_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Clean up storage object if this asset has a file
      if (existing.file_url) {
        await options.blob.bucket(BRAND_KIT_BUCKET).remove([existing.file_url]);
      }

      await repository
        .deleteAsset(actor.instanceId, kitId, assetId)
        .catch(() => {
          throw new BrandKitServiceError(
            "brand_kit_delete_failed",
            KIT_DELETE_FAILED_MESSAGE,
            500,
          );
        });
    },

    async uploadAsset(actor, kitId, assetType, fileName, fileBuffer, mimeType) {
      await options.localInstance.resolve(actor);
      // Verify kit exists and belongs to user
      let kitId_: string | null;
      try {
        kitId_ = await repository.findKitRef(actor.instanceId, kitId);
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          500,
        );
      }

      if (!kitId_) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      const bucket = options.blob.bucket(BRAND_KIT_BUCKET);

      // Upload to storage
      const timestamp = Date.now();
      const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectPath = `${actor.instanceId}/${kitId}/${timestamp}-${safeName}`;

      try {
        await bucket.upload(objectPath, fileBuffer, {
          contentType: mimeType,
          upsert: false,
        });
      } catch (error) {
        throw new BrandKitServiceError(
          "brand_kit_asset_create_failed",
          `File upload failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          500,
        );
      }

      const maxSortOrder = await repository
        .maxAssetSortOrder(actor.instanceId, kitId, assetType)
        .catch(() => null);

      // Create asset record — store object path in file_url
      const displayName = fileName.replace(/\.[^.]+$/, "");
      const asset = await repository
        .insertAsset(actor.instanceId, kitId, {
          asset_type: assetType,
          display_name: displayName,
          file_url: objectPath,
          sort_order: (maxSortOrder ?? -1) + 1,
        })
        .catch(() => null);

      if (!asset) {
        // Clean up uploaded file on DB failure
        await bucket.remove([objectPath]);
        throw new BrandKitServiceError(
          "brand_kit_asset_create_failed",
          ASSET_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      // 本桶非公开 → 走 blob 缝的 resolveUrl（公开桶会自然给公网 URL）
      const mapped = mapAssetRow(asset);
      try {
        mapped.file_url = await bucket.resolveUrl(
          objectPath,
          SIGNED_URL_EXPIRY_SECONDS,
        );
      } catch {
        // 拿不到 URL 不影响资产已创建的事实：保持 file_url 为对象路径
      }
      return mapped;
    },

    async duplicateKit(actor, kitId) {
      await options.localInstance.resolve(actor);
      let source: { guidance_text: string | null; name: string } | null;
      try {
        source = await repository.findKitSource(actor.instanceId, kitId);
      } catch {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          500,
        );
      }

      if (!source) {
        throw new BrandKitServiceError(
          "brand_kit_not_found",
          KIT_NOT_FOUND_MESSAGE,
          404,
        );
      }

      // Create new kit (never copy is_default)
      const newKitId = await repository
        .insertKit(actor.instanceId, {
          guidance_text: source.guidance_text,
          name: `${source.name} (副本)`,
        })
        .catch(() => null);

      if (!newKitId) {
        throw new BrandKitServiceError(
          "brand_kit_create_failed",
          KIT_CREATE_FAILED_MESSAGE,
          500,
        );
      }

      // Copy assets (file-based ones copy the storage object too)
      const assets = await repository
        .listAssets(actor.instanceId, kitId)
        .catch(() => []);

      if (assets.length > 0) {
        const bucket = options.blob.bucket(BRAND_KIT_BUCKET);
        const copies = [];

        for (const asset of assets) {
          let newFileUrl: string | null = null;

          // For file-based assets, copy the storage object
          if (asset.file_url) {
            const ext = asset.file_url.split(".").pop() ?? "bin";
            const newPath = `${actor.instanceId}/${newKitId}/${Date.now()}-copy.${ext}`;
            try {
              await bucket.copy(asset.file_url, newPath);
              newFileUrl = newPath;
            } catch {
              // 复制失败则该项留空，不阻断整次复制
            }
          }

          copies.push({
            asset_type: asset.asset_type,
            display_name: asset.display_name,
            file_url: newFileUrl,
            metadata: asset.metadata,
            role: asset.role,
            sort_order: asset.sort_order,
            text_content: asset.text_content,
          });
        }

        await repository.insertAssets(actor.instanceId, newKitId, copies);
      }

      return fetchKitDetail(actor, newKitId);
    },
  };
}

function mapAssetRow(row: BrandKitAssetRow): BrandKitAsset {
  return {
    id: row.id,
    asset_type: row.asset_type as BrandKitAsset["asset_type"],
    display_name: row.display_name,
    role: row.role,
    sort_order: row.sort_order,
    text_content: row.text_content,
    file_url: row.file_url,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
