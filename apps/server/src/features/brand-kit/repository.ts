import type { PersistenceService } from "../persistence/types.js";

export type BrandKitRow = {
  id: string;
  name: string;
  is_default: boolean;
  guidance_text: string | null;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
};

export type BrandKitSummaryRow = Omit<
  BrandKitRow,
  "guidance_text" | "updated_at"
> & { updated_at: string };

export type BrandKitAssetRow = {
  id: string;
  asset_type: string;
  display_name: string;
  role: string | null;
  sort_order: number;
  text_content: string | null;
  file_url: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

export type NewBrandKitAsset = {
  asset_type: string;
  display_name: string;
  file_url?: string | null | undefined;
  metadata?: unknown;
  role?: string | null | undefined;
  sort_order: number;
  text_content?: string | null | undefined;
};

export type BrandKitPatch = {
  guidance_text?: string | null | undefined;
  is_default?: boolean | undefined;
  name?: string | undefined;
};

export type BrandKitAssetPatch = {
  display_name?: string | undefined;
  metadata?: unknown;
  role?: string | null | undefined;
  sort_order?: number | undefined;
  text_content?: string | null | undefined;
};

const KIT_COLUMNS =
  "id, name, is_default, guidance_text, cover_url, created_at, updated_at";
const KIT_SUMMARY_COLUMNS =
  "id, name, is_default, cover_url, created_at, updated_at";
const ASSET_COLUMNS =
  "id, asset_type, display_name, role, sort_order, text_content, file_url, metadata, created_at, updated_at";

/**
 * brand-kit 聚合的数据访问。
 *
 * **隔离口径**：`brand_kits` 按 `instance_id` 定权（schema 早于 实例，无
 * `instance_id` 列），故经 `forInstance` 的 `:instance` 谓词；`brand_kit_assets` 自身
 * 既无 `instance_id` 也无 `instance_id`，一律经父链
 * `exists (select 1 from brand_kits k where k.id = <asset.kit_id> and k.instance_id = :instance)`
 * 限定——**归属校验与读写是同一条语句**，不存在「先查归属再操作」的窗口。
 */
export interface BrandKitRepository {
  /** 把该实例其余套件的 is_default 清掉（设默认前的互斥步骤）。 */
  clearDefault(instanceId: string): Promise<number>;
  deleteAsset(
    instanceId: string,
    kitId: string,
    assetId: string,
  ): Promise<number>;
  deleteKit(instanceId: string, kitId: string): Promise<number>;
  findAsset(
    instanceId: string,
    kitId: string,
    assetId: string,
  ): Promise<BrandKitAssetRow | null>;
  findAssetRef(
    instanceId: string,
    kitId: string,
    assetId: string,
  ): Promise<{ file_url: string | null; id: string } | null>;
  findKit(instanceId: string, kitId: string): Promise<BrandKitRow | null>;
  /** 仅取 id 的存在性检查（建资产/上传前的套件校验）。 */
  findKitRef(instanceId: string, kitId: string): Promise<string | null>;
  /** 复制套件时取源套件的可复制字段。 */
  findKitSource(
    instanceId: string,
    kitId: string,
  ): Promise<{ guidance_text: string | null; name: string } | null>;
  insertAsset(
    instanceId: string,
    kitId: string,
    input: NewBrandKitAsset,
  ): Promise<BrandKitAssetRow | null>;
  /** 批量插入（复制套件用）：单条语句，归属校验在内。 */
  insertAssets(
    instanceId: string,
    kitId: string,
    rows: readonly NewBrandKitAsset[],
  ): Promise<number>;
  insertKit(
    instanceId: string,
    input: { guidance_text?: string | null | undefined; name: string },
  ): Promise<string | null>;
  listAssetCounts(
    instanceId: string,
    kitIds: readonly string[],
  ): Promise<Array<{ asset_type: string; kit_id: string }>>;
  listAssetFilePaths(instanceId: string, kitId: string): Promise<string[]>;
  listAssets(instanceId: string, kitId: string): Promise<BrandKitAssetRow[]>;
  listKits(instanceId: string): Promise<BrandKitSummaryRow[]>;
  maxAssetSortOrder(
    instanceId: string,
    kitId: string,
    assetType: string,
  ): Promise<number | null>;
  updateAsset(
    instanceId: string,
    kitId: string,
    assetId: string,
    patch: BrandKitAssetPatch,
  ): Promise<BrandKitAssetRow | null>;
  updateKit(
    instanceId: string,
    kitId: string,
    patch: BrandKitPatch,
  ): Promise<number>;
}

/** 资产归属校验片段：经父链确认套件属于该实例。 */
const assetOwnedByInstance = (kitIdExpr: string) =>
  `exists (select 1 from public.brand_kits k where k.id = ${kitIdExpr} and k.instance_id = :instance)`;

/**
 * 把补丁翻成 SET 片段。`seed` 是 WHERE 已占用的前导参数（如 `[id]` 或
 * `[id, kitId]`），列占位符从 `seed.length + 1` 续号——**不这样做会与 WHERE 的
 * 占位符撞号**（`set name = $1` 把 id 写进 name）。
 */
function buildPatch(
  patch: Record<string, unknown>,
  seed: readonly unknown[],
  casts: Record<string, string> = {},
): { assignments: string[]; values: unknown[] } | null {
  const assignments: string[] = [];
  const values: unknown[] = [...seed];

  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    values.push(column === "metadata" ? JSON.stringify(value) : value);
    assignments.push(`${column} = $${values.length}${casts[column] ?? ""}`);
  }

  return assignments.length === 0 ? null : { assignments, values };
}

export function createBrandKitRepository(
  persistence: PersistenceService,
): BrandKitRepository {
  return {
    async listKits(instanceId) {
      return persistence.forInstance(instanceId).query<BrandKitSummaryRow>(
        `select ${KIT_SUMMARY_COLUMNS}
           from public.brand_kits
          where instance_id = :instance
          order by created_at asc`,
      );
    },

    async findKit(instanceId, kitId) {
      return persistence.forInstance(instanceId).queryOne<BrandKitRow>(
        `select ${KIT_COLUMNS}
           from public.brand_kits
          where instance_id = :instance
            and id = $1`,
        [kitId],
      );
    },

    async findKitRef(instanceId, kitId) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ id: string }>(
          `select id
           from public.brand_kits
          where instance_id = :instance
            and id = $1`,
          [kitId],
        );
      return row?.id ?? null;
    },

    async findKitSource(instanceId, kitId) {
      return persistence
        .forInstance(instanceId)
        .queryOne<{ guidance_text: string | null; name: string }>(
          `select name, guidance_text
             from public.brand_kits
            where instance_id = :instance
              and id = $1`,
          [kitId],
        );
    },

    async insertKit(instanceId, input) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ id: string }>(
          `insert into public.brand_kits (instance_id, name, guidance_text)
         values (:instance, $1, $2)
         returning id`,
          [input.name, input.guidance_text ?? null],
        );
      return row?.id ?? null;
    },

    async clearDefault(instanceId) {
      return persistence.forInstance(instanceId).execute(
        `update public.brand_kits
            set is_default = false
          where instance_id = :instance
            and is_default = true`,
      );
    },

    async updateKit(instanceId, kitId, patch) {
      const built = buildPatch(patch, [kitId]);
      if (!built) {
        return 0;
      }

      return persistence.forInstance(instanceId).execute(
        `update public.brand_kits
            set ${built.assignments.join(", ")}
          where instance_id = :instance
            and id = $1`,
        built.values,
      );
    },

    async deleteKit(instanceId, kitId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.brand_kits
          where instance_id = :instance
            and id = $1`,
        [kitId],
      );
    },

    async listAssets(instanceId, kitId) {
      return persistence.forInstance(instanceId).query<BrandKitAssetRow>(
        `select ${ASSET_COLUMNS}
           from public.brand_kit_assets a
          where a.kit_id = $1
            and ${assetOwnedByInstance("a.kit_id")}
          order by a.sort_order asc, a.created_at asc`,
        [kitId],
      );
    },

    async listAssetCounts(instanceId, kitIds) {
      if (kitIds.length === 0) {
        return [];
      }
      return persistence
        .forInstance(instanceId)
        .query<{ asset_type: string; kit_id: string }>(
          `select a.kit_id, a.asset_type
             from public.brand_kit_assets a
            where a.kit_id = any($1::uuid[])
              and ${assetOwnedByInstance("a.kit_id")}`,
          [kitIds],
        );
    },

    async listAssetFilePaths(instanceId, kitId) {
      const rows = await persistence
        .forInstance(instanceId)
        .query<{ file_url: string | null }>(
          `select a.file_url
             from public.brand_kit_assets a
            where a.kit_id = $1
              and a.file_url is not null
              and ${assetOwnedByInstance("a.kit_id")}`,
          [kitId],
        );
      return rows
        .map((row) => row.file_url)
        .filter((path): path is string => !!path);
    },

    async findAsset(instanceId, kitId, assetId) {
      return persistence.forInstance(instanceId).queryOne<BrandKitAssetRow>(
        `select ${ASSET_COLUMNS}
           from public.brand_kit_assets a
          where a.id = $1
            and a.kit_id = $2
            and ${assetOwnedByInstance("a.kit_id")}`,
        [assetId, kitId],
      );
    },

    async findAssetRef(instanceId, kitId, assetId) {
      return persistence
        .forInstance(instanceId)
        .queryOne<{ file_url: string | null; id: string }>(
          `select a.id, a.file_url
             from public.brand_kit_assets a
            where a.id = $1
              and a.kit_id = $2
              and ${assetOwnedByInstance("a.kit_id")}`,
          [assetId, kitId],
        );
    },

    async maxAssetSortOrder(instanceId, kitId, assetType) {
      const row = await persistence
        .forInstance(instanceId)
        .queryOne<{ sort_order: number }>(
          `select a.sort_order
             from public.brand_kit_assets a
            where a.kit_id = $1
              and a.asset_type = $2::public.brand_kit_asset_type
              and ${assetOwnedByInstance("a.kit_id")}
            order by a.sort_order desc
            limit 1`,
          [kitId, assetType],
        );
      return row?.sort_order ?? null;
    },

    async insertAsset(instanceId, kitId, input) {
      return persistence.forInstance(instanceId).queryOne<BrandKitAssetRow>(
        `insert into public.brand_kit_assets
                (kit_id, asset_type, display_name, role, sort_order,
                 text_content, file_url, metadata)
         select $1, $2::public.brand_kit_asset_type, $3, $4, $5, $6, $7, $8::jsonb
          where ${assetOwnedByInstance("$1")}
         returning ${ASSET_COLUMNS}`,
        [
          kitId,
          input.asset_type,
          input.display_name,
          input.role ?? null,
          input.sort_order,
          input.text_content ?? null,
          input.file_url ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
    },

    async insertAssets(instanceId, kitId, rows) {
      if (rows.length === 0) {
        return 0;
      }

      // 单条语句批量插入：归属校验内联在 WHERE，整批原子生效。
      // 这个 `insert … select … from (values …)` 形状里，Postgres **不会**把
      // 目标列的类型反推给未定型参数（unknown 一律按 text 处理），故凡不是 text 的列
      // 都必须显式 cast：`kit_id::uuid` 漏了报 `operator does not exist: uuid = text`
      // （42883），`sort_order::int` 漏了报 `column "sort_order" is of type integer
      // but expression is of type text`（42804）。
      const values: unknown[] = [kitId];
      const tuples = rows.map((row) => {
        values.push(
          row.asset_type,
          row.display_name,
          row.role ?? null,
          row.sort_order,
          row.text_content ?? null,
          row.file_url ?? null,
          JSON.stringify(row.metadata ?? {}),
        );
        const end = values.length;
        const start = end - 6;
        return `($1::uuid, $${start}::public.brand_kit_asset_type, $${start + 1}, $${start + 2}, $${start + 3}::int, $${start + 4}, $${start + 5}, $${end}::jsonb)`;
      });

      return persistence.forInstance(instanceId).execute(
        `insert into public.brand_kit_assets
                (kit_id, asset_type, display_name, role, sort_order,
                 text_content, file_url, metadata)
         select v.*
           from (values ${tuples.join(", ")})
                  as v(kit_id, asset_type, display_name, role, sort_order,
                       text_content, file_url, metadata)
          where ${assetOwnedByInstance("$1")}`,
        values,
      );
    },

    async updateAsset(instanceId, kitId, assetId, patch) {
      const built = buildPatch(patch, [assetId, kitId], {
        metadata: "::jsonb",
      });
      if (!built) {
        return null;
      }

      return persistence.forInstance(instanceId).queryOne<BrandKitAssetRow>(
        `update public.brand_kit_assets a
            set ${built.assignments.join(", ")}
          where a.id = $1
            and a.kit_id = $2
            and ${assetOwnedByInstance("a.kit_id")}
        returning ${ASSET_COLUMNS}`,
        built.values,
      );
    },

    async deleteAsset(instanceId, kitId, assetId) {
      return persistence.forInstance(instanceId).execute(
        `delete from public.brand_kit_assets a
          where a.id = $1
            and a.kit_id = $2
            and ${assetOwnedByInstance("a.kit_id")}`,
        [assetId, kitId],
      );
    },
  };
}
