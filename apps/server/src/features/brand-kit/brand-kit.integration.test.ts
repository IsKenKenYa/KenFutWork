import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalInstanceRepository } from "../local-instance/repository.js";
import { createTaskWorkDatabase } from "../task-work/test-postgres-schema.js";
import { createBrandKitRepository } from "./repository.js";

describe.skipIf(process.env.KENFUTWORK_CRUD_TEST_PG !== "1")(
  "实例品牌套件真实 Postgres",
  () => {
    it("父链隔离、错误父目标拒绝、元数据更新和重复删除成立", async () => {
      const database = await createTaskWorkDatabase();
      try {
        const instanceId = await createLocalInstanceRepository(
          database.persistence,
        ).ensure();
        const repository = createBrandKitRepository(database.persistence);
        const kitId = await repository.insertKit(instanceId, {
          name: "本地品牌",
        });
        const otherKitId = await repository.insertKit(instanceId, {
          name: "另一品牌",
        });
        if (!kitId || !otherKitId) throw new Error("品牌夹具未创建。");
        const asset = await repository.insertAsset(instanceId, kitId, {
          asset_type: "color",
          display_name: "主色",
          text_content: "#123456",
          sort_order: 0,
        });
        if (!asset) throw new Error("品牌资产未创建。");
        expect(await repository.findKit(randomUUID(), kitId)).toBeNull();
        expect(await repository.listAssets(randomUUID(), kitId)).toEqual([]);
        expect(
          await repository.findAsset(instanceId, otherKitId, asset.id),
        ).toBeNull();
        expect(
          await repository.updateAsset(instanceId, otherKitId, asset.id, {
            display_name: "错误父目标",
          }),
        ).toBeNull();
        expect(
          await repository.updateAsset(instanceId, kitId, asset.id, {
            text_content: "#abcdef",
          }),
        ).toMatchObject({ text_content: "#abcdef" });
        expect(await repository.deleteKit(instanceId, kitId)).toBe(1);
        expect(await repository.deleteKit(instanceId, kitId)).toBe(0);
      } finally {
        await database.close();
      }
    });
  },
);
