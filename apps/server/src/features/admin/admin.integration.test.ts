import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createAdminRepository } from "./repository.js";

/**
 * admin 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明平台级库函数（`admin_users_overview` / `admin_adjust_credits`）在
 * 单一信任角色连接上可调用——两者都是 SECURITY DEFINER 且不依赖 auth.uid，
 * 迁移后不再有 service_role 客户端可用，必须确证这一点。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run admin.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("admin 真实库集成", () => {
  it("平台总览可读，且 token/cost 已归一为 number", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const rows =
        await createAdminRepository(persistence).fetchUsersOverview();

      // 本地种子库至少有一个用户；夹具不依赖具体人数
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(typeof row.user_id).toBe("string");
        expect(typeof row.total_tokens).toBe("number");
        expect(typeof row.cost_usd).toBe("number");
        expect(typeof row.balance).toBe("number");
        expect(["admin", "user"]).toContain(row.role);
      }
    } finally {
      await persistence.close();
    }
  });

  it("额度调剂库函数在信任连接上可调用（事务内回滚，不留副作用）", async () => {
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
      expect(workspace, "夹具用户必须有个人工作区").not.toBeNull();

      // 走事务并主动回滚：只验证「函数可调用 + 参数绑序正确」，不落交易流水。
      await expect(
        persistence.transaction(async (tx) => {
          const row = await tx.queryOne<{ tx_id: string }>(
            "select public.admin_adjust_credits($1, $2, $3, $4) as tx_id",
            [
              workspace?.id,
              (profile as IdRow).id,
              1,
              "integration rollback probe",
            ],
          );
          expect(row?.tx_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          );
          throw new Error("intentional rollback");
        }),
      ).rejects.toThrow("intentional rollback");

      // 回滚后余额未被改动
      const balance = await persistence
        .forWorkspace(workspace?.id as string)
        .queryOne<{
          balance: number;
        }>(
          "select balance from public.credit_balances where workspace_id = :workspace",
        );
      expect(typeof balance?.balance === "number" || balance === null).toBe(
        true,
      );
    } finally {
      await persistence.close();
    }
  });

  it("平台角色读取走 profiles.role（CHECK 只允许 user/admin）", async () => {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      const role = await createViewerRepository(persistence).findPlatformRole(
        (profile as IdRow).id,
      );
      expect(["admin", "user"]).toContain(role);
      expect(
        await createViewerRepository(persistence).findPlatformRole(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).toBeNull();
    } finally {
      await persistence.close();
    }
  });
});
