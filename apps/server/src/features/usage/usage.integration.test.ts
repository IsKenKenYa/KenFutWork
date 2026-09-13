import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createUsageRepository } from "./repository.js";

/**
 * usage 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：确证 `bigint`（token 列）与 `numeric`（cost_usd）经真库读回后被归一为
 * number——这两种列在 node-postgres 下都返回字符串，是静默破坏契约的高危点。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run usage.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const FOREIGN_WORKSPACE = "00000000-0000-0000-0000-000000000000";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("usage 真实库集成", () => {
  it("写入后读回：token 列与 cost_usd 都是 number，且按工作区隔离", async () => {
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

      // 用可识别的 provider 标记本夹具，便于精确清理。
      const marker = `integration-${Date.now().toString(36)}`;
      const usage = createUsageRepository(persistence);

      try {
        await usage.insert({
          workspaceId,
          userId: (profile as IdRow).id,
          provider: marker,
          model: "gpt-4.1",
          capability: "chat",
          runId: "run-integration",
          inputTokens: 1234,
          outputTokens: 567,
          totalTokens: 1801,
          costUsd: 0.0123,
        });

        const rows = await usage.listRecent(workspaceId, 100);
        const row = rows.find((entry) => entry.provider === marker);

        expect(row).toBeDefined();
        expect(row?.input_tokens).toBe(1234);
        expect(row?.output_tokens).toBe(567);
        expect(row?.cost_usd).toBeCloseTo(0.0123, 6);
        expect(typeof row?.input_tokens).toBe("number");
        expect(typeof row?.cost_usd).toBe("number");

        // 跨工作区读不到
        const foreign = await usage.listRecent(FOREIGN_WORKSPACE, 100);
        expect(foreign.some((entry) => entry.provider === marker)).toBe(false);
      } finally {
        await persistence.query(
          "delete from public.usage_records where provider = $1",
          [marker],
        );
      }
    } finally {
      await persistence.close();
    }
  });

  it("cost_usd 缺省时读回 null（不是 0，也不是字符串）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      const workspace = await createViewerRepository(
        persistence,
      ).findPersonalWorkspace((profile as IdRow).id);
      const workspaceId = workspace?.id as string;

      const marker = `integration-nocost-${Date.now().toString(36)}`;
      const usage = createUsageRepository(persistence);

      try {
        await usage.insert({
          workspaceId,
          provider: marker,
          model: "gemini",
          capability: "image",
        });

        const rows = await usage.listRecent(workspaceId, 100);
        const row = rows.find((entry) => entry.provider === marker);
        expect(row?.cost_usd).toBeNull();
        expect(row?.input_tokens).toBe(0);
      } finally {
        await persistence.query(
          "delete from public.usage_records where provider = $1",
          [marker],
        );
      }
    } finally {
      await persistence.close();
    }
  });
});
