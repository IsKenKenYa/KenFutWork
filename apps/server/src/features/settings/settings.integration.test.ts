import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createSettingsRepository } from "./repository.js";

/**
 * settings 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：验证 upsert 的 ON CONFLICT (workspace_id) 语法与读回在真库成立。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run settings.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("settings 真实库集成", () => {
  it("upsert 可重复执行且读回最新值，原值随后还原", async () => {
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

      const settings = createSettingsRepository(persistence);
      const original = await settings.findDefaultModel(workspaceId);

      try {
        await settings.upsertDefaultModel(workspaceId, "integration-model-a");
        await expect(settings.findDefaultModel(workspaceId)).resolves.toBe(
          "integration-model-a",
        );

        // 幂等：同键再次 upsert 走更新分支而非报冲突。
        await settings.upsertDefaultModel(workspaceId, "integration-model-b");
        await expect(settings.findDefaultModel(workspaceId)).resolves.toBe(
          "integration-model-b",
        );
      } finally {
        if (original !== null) {
          await settings.upsertDefaultModel(workspaceId, original);
        }
      }
    } finally {
      await persistence.close();
    }
  });

  it("跨工作区读不到设置（隔离门禁）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const settings = createSettingsRepository(persistence);
      await expect(
        settings.findDefaultModel("00000000-0000-0000-0000-000000000000"),
      ).resolves.toBeNull();
    } finally {
      await persistence.close();
    }
  });
});
