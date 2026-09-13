import { describe, expect, it } from "vitest";

import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createBrandKitRepository } from "./repository.js";

/**
 * brand-kit 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明 `brand_kits` 的 `:user` 隔离与 `brand_kit_assets` 的父链归属校验
 * 在真库上成立——另一用户作用域既看不到套件、也看不到其资产，且资产写入无法
 * 挂到别人的套件上。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run brand-kit.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const OTHER_USER = "11111111-1111-1111-1111-111111111111";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("brand-kit 真实库集成", () => {
  it("套件与资产的增删改查按用户隔离（他人不可见、不可写）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as IdRow).id;

      const brandKits = createBrandKitRepository(persistence);
      const kitId = await brandKits.insertKit(userId, {
        name: `集成套件-${Date.now().toString(36)}`,
      });
      expect(kitId).toBeTruthy();
      const kit = kitId as string;

      try {
        // 读写：本人可见
        await expect(brandKits.findKit(userId, kit)).resolves.toMatchObject({
          name: expect.stringContaining("集成套件-"),
        });
        const listed = await brandKits.listKits(userId);
        expect(listed.map((row) => row.id)).toContain(kit);

        // 资产写入（归属校验内联）
        const asset = await brandKits.insertAsset(userId, kit, {
          asset_type: "color",
          display_name: "主色",
          sort_order: 0,
          text_content: "#123456",
        });
        expect(asset?.asset_type).toBe("color");

        const assets = await brandKits.listAssets(userId, kit);
        expect(assets).toHaveLength(1);
        expect(assets[0]?.text_content).toBe("#123456");

        await expect(brandKits.listAssetCounts(userId, [kit])).resolves.toEqual(
          [{ asset_type: "color", kit_id: kit }],
        );
        await expect(
          brandKits.maxAssetSortOrder(userId, kit, "color"),
        ).resolves.toBe(0);

        // 补丁更新（占位符编号正确：SET 从 $3 起）
        const updated = await brandKits.updateAsset(
          userId,
          kit,
          asset?.id as string,
          {
            display_name: "改名后",
          },
        );
        expect(updated?.display_name).toBe("改名后");

        // 另一个用户作用域：套件与资产都不可见
        await expect(brandKits.findKit(OTHER_USER, kit)).resolves.toBeNull();
        await expect(brandKits.listAssets(OTHER_USER, kit)).resolves.toEqual(
          [],
        );
        await expect(
          brandKits.updateAsset(OTHER_USER, kit, asset?.id as string, {
            display_name: "越权改名",
          }),
        ).resolves.toBeNull();
        // 越权往别人的套件里塞资产 → 0 行（归属校验不通过）
        await expect(
          brandKits.insertAsset(OTHER_USER, kit, {
            asset_type: "color",
            display_name: "越权插入",
            sort_order: 99,
          }),
        ).resolves.toBeNull();
        await expect(brandKits.listAssets(userId, kit)).resolves.toHaveLength(
          1,
        );

        // 删除套件（资产经 FK 级联清理）
        await expect(brandKits.deleteKit(userId, kit)).resolves.toBe(1);
        await expect(brandKits.findKit(userId, kit)).resolves.toBeNull();
      } finally {
        await persistence.query("delete from public.brand_kits where id = $1", [
          kit,
        ]);
      }
    } finally {
      await persistence.close();
    }
  });
});
