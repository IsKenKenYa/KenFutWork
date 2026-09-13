import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createUploadRepository } from "./repository.js";

/**
 * uploads 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：确证 bigint 列经 pg 驱动回来的真实形状，以及元数据读写的工作区隔离。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run uploads.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("uploads 真实库集成", () => {
  it("插入元数据后 byte_size 为 number（驱动 int8 形状已归一），并可按工作区读回删除", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();

      const workspace = await createViewerRepository(
        persistence,
      ).findPersonalWorkspace((profile as IdRow).id);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      // 先看驱动原始形状，作为「归一是否必要」的现场证据。
      const raw = await persistence.queryOne<{ byte_size: unknown }>(
        "select $1::bigint as byte_size",
        [9007199254740991n],
      );
      expect(["string", "number"]).toContain(typeof raw?.byte_size);

      const uploads = createUploadRepository(persistence);
      const asset = await uploads.insert({
        bucket: "project-assets",
        byteSize: 4242,
        mimeType: "image/png",
        objectPath: `${workspaceId}/integration/asset.png`,
        userId: (profile as IdRow).id,
        workspaceId,
      });

      try {
        expect(asset?.byte_size).toBe(4242);
        expect(typeof asset?.byte_size).toBe("number");
        expect(asset?.workspace_id).toBe(workspaceId);

        await expect(
          uploads.findLocation(workspaceId, asset?.id as string),
        ).resolves.toEqual({
          bucket: "project-assets",
          object_path: `${workspaceId}/integration/asset.png`,
        });

        // 跨工作区看不到、删不掉。
        const foreign = "00000000-0000-0000-0000-000000000000";
        await expect(
          uploads.findLocation(foreign, asset?.id as string),
        ).resolves.toBeNull();
        await expect(
          uploads.deleteById(foreign, asset?.id as string),
        ).resolves.toBe(0);
      } finally {
        await persistence.query(
          "delete from public.asset_objects where id = $1",
          [asset?.id],
        );
      }

      await expect(
        uploads.deleteById(workspaceId, asset?.id as string),
      ).resolves.toBe(0);
    } finally {
      await persistence.close();
    }
  });
});
