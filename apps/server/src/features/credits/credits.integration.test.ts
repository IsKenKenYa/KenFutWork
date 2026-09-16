import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createCreditRepository } from "./repository.js";

/**
 * credits 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 * 目的：证明四张表的读写与六个库函数在单一信任角色连接上都可用——
 * 尤其 `grant_plan_credits` 的 **enum 参数 cast** 与「额度不足」异常消息
 * （服务层据消息含 `INSUFFICIENT_CREDITS` 映射 402）。
 *
 * 变更型库函数一律在**事务内主动回滚**探测，不留余额/台账副作用
 * （repository 走根客户端，故探针直接调同名 SQL；repository 自身的语句形状由
 * 单测断言）。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @kenfutwork/server exec vitest run credits.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("credits 真实库集成", () => {
  async function withWorkspace(
    run: (input: {
      persistence: ReturnType<typeof createPostgresPersistence>;
      userId: string;
      workspaceId: string;
    }) => Promise<void>,
  ) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<IdRow>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as IdRow).id;

      const workspace =
        await createViewerRepository(persistence).findPersonalWorkspace(userId);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      await run({ persistence, userId, workspaceId });
    } finally {
      await persistence.close();
    }
  }

  it("四张表读取得回，且 bigint/numeric 计数按 number 使用", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      const credits = createCreditRepository(persistence);

      // 余额/套餐可能无行（未引导），此处只断言「可读且类型正确」
      const balance = await credits.findBalance(workspaceId);
      expect(balance === null || typeof balance === "number").toBe(true);

      const plan = await credits.findPlan(workspaceId);
      expect(plan === null || typeof plan === "string").toBe(true);

      const subscription = await credits.findSubscription(workspaceId);
      expect(
        subscription === null || typeof subscription.plan === "string",
      ).toBe(true);

      const claimed = await credits.hasClaimedToday(workspaceId, "1970-01-01");
      expect(typeof claimed).toBe("boolean");

      const transactions = await credits.listTransactions(workspaceId, 5);
      expect(Array.isArray(transactions)).toBe(true);
      for (const tx of transactions) {
        expect(typeof tx.amount).toBe("number");
        expect(typeof tx.balance_after).toBe("number");
      }
    });
  });

  it("grant_plan_credits 的 enum 参数 cast 在信任连接上有效（事务内回滚）", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      await expect(
        persistence.transaction(async (tx) => {
          const row = await tx.queryOne<{ credits: number }>(
            "select public.grant_plan_credits($1, $2::public.subscription_plan, $3) as credits",
            [workspaceId, "pro", 0],
          );
          expect(typeof row?.credits === "number" || row === null).toBe(true);
          throw new Error("intentional rollback");
        }),
      ).rejects.toThrow("intentional rollback");
    });
  });

  it("deduct_credits 在余额不足时抛含 INSUFFICIENT_CREDITS 的错误（事务内回滚）", async () => {
    await withWorkspace(async ({ persistence, userId, workspaceId }) => {
      const outcome = await persistence
        .transaction(async (tx) => {
          await tx.query("select public.deduct_credits($1, $2, $3, $4, $5)", [
            workspaceId,
            userId,
            999_999_999,
            null,
            "integration probe",
          ]);
          return "unexpectedly-succeeded";
        })
        .catch((error: unknown) =>
          error instanceof Error ? error.message : "",
        );

      // 服务层就是靠这个消息 token 映射 402，故这里必须确认它真的出现
      expect(outcome).toContain("INSUFFICIENT_CREDITS");
    });
  });

  it("claim_daily_credits 可调用且返回布尔（事务内回滚）", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      const claimed = await persistence
        .transaction(async (tx) => {
          const row = await tx.queryOne<{ claimed: boolean }>(
            "select public.claim_daily_credits($1, $2) as claimed",
            [workspaceId, 50],
          );
          const result = row?.claimed;
          throw Object.assign(new Error("intentional rollback"), { result });
        })
        .catch((error: unknown) => (error as { result?: unknown }).result);

      expect(typeof claimed).toBe("boolean");
    });
  });
});
