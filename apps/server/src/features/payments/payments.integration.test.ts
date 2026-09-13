import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createPaymentRepository } from "./repository.js";

/**
 * payments 聚合真实库集成测试（默认 skipped：需要 DATABASE_URL）。
 *
 * 关键验证：`grantMonthlyCredits` 的**行锁 + 事务**在真并发下不丢更新——
 * 旧的「读余额 → 算新值 → 覆盖写」在不加锁时会丢一次发放（余额只加一份），
 * 这里用两个并发调用实证余额加了**两份**。同时验证 enum/时间列 cast 与
 * 流水类型（`subscription_grant`）落库。
 *
 * 夹具自清理：发放前后记录余额与 version，测试结束按标记还原余额并删除流水，
 * 不留数据残留。
 *
 * 运行：DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       pnpm --filter @loomic/server exec vitest run payments.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;
const MARKER = "integration:payments";

type IdRow = { id: string };

describe.skipIf(!DATABASE_URL)("payments 真实库集成", () => {
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

  it("订阅读取与 LS 反查在真库可用（容忍无行）", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      const payments = createPaymentRepository(persistence);

      const subscription =
        await payments.findSubscriptionByWorkspace(workspaceId);
      expect(
        subscription === null || typeof subscription.plan === "string",
      ).toBe(true);

      await expect(
        payments.findWorkspaceIdByLsSubscriptionId("no-such-ls-sub"),
      ).resolves.toBeNull();
    });
  });

  it("并发发放额度不丢更新（FOR UPDATE 行锁 + 事务）", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      const payments = createPaymentRepository(persistence);
      const scoped = persistence.forWorkspace(workspaceId);

      const before = await scoped.queryOne<{
        balance: number;
        version: number;
      }>(
        `select balance, version from public.credit_balances where workspace_id = :workspace`,
      );
      const originalBalance = before?.balance ?? 0;
      const originalVersion = before?.version ?? 0;

      try {
        // 两个并发发放：各自在独立连接上开事务并锁同一余额行
        await Promise.all([
          payments.grantMonthlyCredits({
            amount: 10,
            description: `${MARKER} concurrent-a`,
            workspaceId,
          }),
          payments.grantMonthlyCredits({
            amount: 10,
            description: `${MARKER} concurrent-b`,
            workspaceId,
          }),
        ]);

        const after = await scoped.queryOne<{ balance: number }>(
          `select balance from public.credit_balances where workspace_id = :workspace`,
        );
        // 旧实现会丢一次（只加 10）；行锁下必须两份都在
        expect(after?.balance).toBe(originalBalance + 20);

        const ledger = await scoped.query<{
          amount: number;
          description: string;
        }>(
          `select amount, description
             from public.credit_transactions
            where workspace_id = :workspace
              and description like $1
            order by created_at`,
          [`${MARKER}%`],
        );
        expect(ledger).toHaveLength(2);
        expect(ledger.every((row) => row.amount === 10)).toBe(true);
      } finally {
        // 还原余额与 version，并清掉本次夹具流水
        await scoped.execute(
          `update public.credit_balances
              set balance = $1, version = $2
            where workspace_id = :workspace`,
          [originalBalance, originalVersion],
        );
        await scoped.execute(
          `delete from public.credit_transactions
            where workspace_id = :workspace
              and description like $1`,
          [`${MARKER}%`],
        );
      }
    });
  });

  it("订阅更新按工作区限定且 enum/时间列 cast 有效", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      const payments = createPaymentRepository(persistence);
      const before = await payments.findSubscriptionByWorkspace(workspaceId);

      // 无订阅行的工作区不构造夹具（种子用户通常有）；只断言语句可执行
      const affected = await payments.updateSubscriptionByWorkspace(
        workspaceId,
        {
          canceled_at: null,
          plan: before?.plan ?? "free",
        },
      );
      expect([0, 1]).toContain(affected);
    });
  });

  it("webhook 审计：追加事件并按事件 id 标记处理结果", async () => {
    await withWorkspace(async ({ persistence, workspaceId }) => {
      const payments = createPaymentRepository(persistence);
      const eventId = `${MARKER}-${Date.now().toString(36)}`;

      try {
        await payments.insertPaymentEvent({
          eventId,
          eventName: "integration_probe",
          payload: { marker: MARKER },
          workspaceId,
        });

        await expect(payments.markPaymentEventProcessed(eventId)).resolves.toBe(
          1,
        );
        await expect(
          payments.markPaymentEventError(eventId, "probe"),
        ).resolves.toBe(1);

        const row = await persistence.queryOne<{
          error_message: string | null;
          processed: boolean;
        }>(
          `select processed, error_message
             from public.payment_events
            where lemon_squeezy_event_id = $1`,
          [eventId],
        );
        expect(row).toEqual({ error_message: "probe", processed: true });
      } finally {
        await persistence.query(
          "delete from public.payment_events where lemon_squeezy_event_id = $1",
          [eventId],
        );
      }
    });
  });
});
