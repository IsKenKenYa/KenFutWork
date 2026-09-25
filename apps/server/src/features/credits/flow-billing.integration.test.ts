import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createViewerRepository } from "../bootstrap/repository.js";
import { createPostgresPersistence } from "../persistence/providers/postgres.js";
import { createCreditRepository } from "./repository.js";

/**
 * flow 三段事务的**真实库**集成回归（默认 skipped：需要 DATABASE_URL）。
 *
 * 目标（《flow 集成方案》P4 验证口径：幂等重放 / 并发 / 退款 / 余额不足）：
 *  ① 同键重放不重复动账（reserve/settle/refund 各自 replayed=true 且余额只变一次）；
 *  ② 并发同键 reserve 只冻结一次（UNIQUE(workspace_id, run_id) + ON CONFLICT 兜底）；
 *  ③ 退款释放冻结；已释放不再结算、已结算不再退款（状态机拒绝，不静默）；
 *  ④ 可用额度不足 → INSUFFICIENT_CREDITS（服务层据此映射 402）。
 *
 * 夹具纪律：余额/冻结先记录原值，测试用独立 run id，finally 里删 holds/台账并还原余额
 * ——跑完不留副作用（与 credits.integration.test.ts 的「变更型探针」同一条纪律，
 * 这里是跨事务的并发用例，故用显式清理而不是事务回滚）。
 *
 * 运行：DATABASE_URL=postgresql://kenfutwork@127.0.0.1:55433/kenfutwork \
 *       pnpm --filter @kenfutwork/server exec vitest run flow-billing.integration
 */
const DATABASE_URL = process.env.DATABASE_URL;

type BalanceRow = { balance: number; reserved_balance: number };

/**
 * 仓储写入口按契约可能返回 null（真实实现不返回；路由层由服务层兜底抛错）。
 * 集成测试直连仓储，这里把「非空」断言与取值合成一处，避免满屏 `?.`。
 */
function unwrapped<T>(value: T | null): T {
  if (value === null) {
    throw new Error("仓储返回了 null（真实库路径不应发生）");
  }
  return value;
}

describe.skipIf(!DATABASE_URL)("flow 三段事务真实库集成", () => {
  interface Fixture {
    persistence: ReturnType<typeof createPostgresPersistence>;
    credits: ReturnType<typeof createCreditRepository>;
    userId: string;
    workspaceId: string;
    cleanup: (runIds: string[]) => Promise<void>;
  }

  async function withFixture(run: (fixture: Fixture) => Promise<void>) {
    const persistence = createPostgresPersistence({
      databaseUrl: DATABASE_URL as string,
    });

    try {
      const profile = await persistence.queryOne<{ id: string }>(
        "select id from public.profiles order by created_at limit 1",
      );
      expect(profile, "需要至少一个已引导的 profile 作夹具").not.toBeNull();
      const userId = (profile as { id: string }).id;

      const workspace =
        await createViewerRepository(persistence).findPersonalWorkspace(userId);
      const workspaceId = workspace?.id as string;
      expect(workspaceId).toBeTruthy();

      const original = await persistence.queryOne<BalanceRow>(
        "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
        [workspaceId],
      );
      // 固定一笔可预期的可用额度（测试不依赖 seed 的余额数值）
      await persistence.query(
        `insert into public.credit_balances (workspace_id, balance, reserved_balance, version)
         values ($1, 100, 0, 0)
         on conflict (workspace_id)
         do update set balance = 100, reserved_balance = 0, version = credit_balances.version + 1`,
        [workspaceId],
      );

      const cleanup = async (runIds: string[]) => {
        for (const runId of runIds) {
          await persistence.query(
            "delete from public.credit_transactions where business_key like $1",
            [`flow:${runId}:%`],
          );
          await persistence.query(
            "delete from public.flow_credit_holds where workspace_id = $1 and run_id = $2",
            [workspaceId, runId],
          );
        }
        if (original) {
          await persistence.query(
            "update public.credit_balances set balance = $2, reserved_balance = $3, version = version + 1 where workspace_id = $1",
            [workspaceId, original.balance, original.reserved_balance],
          );
        } else {
          await persistence.query(
            "delete from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
        }
      };

      await run({
        persistence,
        credits: createCreditRepository(persistence),
        userId,
        workspaceId,
        cleanup,
      });
    } finally {
      await persistence.close();
    }
  }

  it("reserve → settle：同键重放不重复动账；账目 = 冻结→按实扣结算", async () => {
    await withFixture(
      async ({ persistence, credits, userId, workspaceId, cleanup }) => {
        const runId = `it-${randomUUID()}`;
        try {
          const before = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );

          // reserve 预扣 30
          const first = unwrapped(
            await credits.flowReserveCredits({
              amount: 30,
              runId,
              userId,
              workspaceId,
            }),
          );
          expect(first.replayed).toBe(false);
          expect(first.frozenAmount).toBe(30);
          let balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.reserved_balance).toBe(30);
          expect(balance?.balance).toBe(before?.balance);

          // 重放 reserve：同一 hold，冻结不再叠加
          const replay = await credits.flowReserveCredits({
            amount: 30,
            runId,
            userId,
            workspaceId,
          });
          expect(replay).toEqual({
            holdId: first.holdId,
            frozenAmount: 30,
            replayed: true,
          });
          balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.reserved_balance).toBe(30);

          // settle 实扣 12（≤ 冻结额）
          const settled = unwrapped(
            await credits.flowSettleCredits({
              actualCost: 12,
              runId,
              userId,
              workspaceId,
            }),
          );
          expect(settled.replayed).toBe(false);
          expect(settled.settledAmount).toBe(12);
          expect(settled.uncoveredAmount).toBe(0);
          balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.balance).toBe((before?.balance ?? 0) - 12);
          expect(balance?.reserved_balance).toBe(0);

          // 重放 settle：同一 tx，余额不再变
          const settleReplay = unwrapped(
            await credits.flowSettleCredits({
              actualCost: 12,
              runId,
              userId,
              workspaceId,
            }),
          );
          expect(settleReplay.replayed).toBe(true);
          expect(settleReplay.txId).toBe(settled.txId);
          balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.balance).toBe((before?.balance ?? 0) - 12);
        } finally {
          await cleanup([runId]);
        }
      },
    );
  });

  it("结算超出冻结额：只扣冻结额，超出部分 uncoveredAmount 如实回报", async () => {
    await withFixture(
      async ({ persistence, credits, userId, workspaceId, cleanup }) => {
        const runId = `it-${randomUUID()}`;
        try {
          const before = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          await credits.flowReserveCredits({
            amount: 10,
            runId,
            userId,
            workspaceId,
          });
          const settled = unwrapped(
            await credits.flowSettleCredits({
              actualCost: 25,
              runId,
              userId,
              workspaceId,
            }),
          );
          expect(settled.settledAmount).toBe(10);
          expect(settled.uncoveredAmount).toBe(15);
          const balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.balance).toBe((before?.balance ?? 0) - 10);
          expect(balance?.reserved_balance).toBe(0);
        } finally {
          await cleanup([runId]);
        }
      },
    );
  });

  it("退款释放冻结；已释放不再结算、已结算不再退款（状态机拒绝）", async () => {
    await withFixture(
      async ({ persistence, credits, userId, workspaceId, cleanup }) => {
        const runId = `it-${randomUUID()}`;
        const settledRunId = `it-${randomUUID()}`;
        try {
          const before = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );

          await credits.flowReserveCredits({
            amount: 20,
            runId,
            userId,
            workspaceId,
          });
          const refunded = unwrapped(
            await credits.flowRefundCredits({
              runId,
              userId,
              workspaceId,
            }),
          );
          expect(refunded.replayed).toBe(false);
          expect(refunded.releasedAmount).toBe(20);
          let balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.reserved_balance).toBe(0);
          expect(balance?.balance).toBe(before?.balance);

          // 重放退款：同键返回原结果
          const refundReplay = unwrapped(
            await credits.flowRefundCredits({
              runId,
              userId,
              workspaceId,
            }),
          );
          expect(refundReplay.replayed).toBe(true);
          expect(refundReplay.txId).toBe(refunded.txId);

          // 已释放的 run 不能再结算
          await expect(
            credits.flowSettleCredits({
              actualCost: 5,
              runId,
              userId,
              workspaceId,
            }),
          ).rejects.toThrow(/HOLD_RELEASED/);

          // 已结算的 run 不能再退款
          await credits.flowReserveCredits({
            amount: 5,
            runId: settledRunId,
            userId,
            workspaceId,
          });
          await credits.flowSettleCredits({
            actualCost: 5,
            runId: settledRunId,
            userId,
            workspaceId,
          });
          await expect(
            credits.flowRefundCredits({
              runId: settledRunId,
              userId,
              workspaceId,
            }),
          ).rejects.toThrow(/HOLD_SETTLED/);

          // 无 hold 直接结算/退款 → NO_HOLD
          const absentRunId = `it-${randomUUID()}`;
          await expect(
            credits.flowSettleCredits({
              actualCost: 1,
              runId: absentRunId,
              userId,
              workspaceId,
            }),
          ).rejects.toThrow(/NO_HOLD/);
          balance = await persistence.queryOne<BalanceRow>(
            "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
            [workspaceId],
          );
          expect(balance?.balance).toBe((before?.balance ?? 0) - 5);
          expect(balance?.reserved_balance).toBe(0);
        } finally {
          await cleanup([runId, settledRunId]);
        }
      },
    );
  });

  it("可用额度不足：INSUFFICIENT_CREDITS 且不留 hold（失败原子）", async () => {
    await withFixture(
      async ({ persistence, credits, userId, workspaceId, cleanup }) => {
        const runId = `it-${randomUUID()}`;
        try {
          await expect(
            credits.flowReserveCredits({
              amount: 10_000,
              runId,
              userId,
              workspaceId,
            }),
          ).rejects.toThrow(/INSUFFICIENT_CREDITS/);
          const hold = await persistence.queryOne<{ id: string }>(
            "select id from public.flow_credit_holds where workspace_id = $1 and run_id = $2",
            [workspaceId, runId],
          );
          expect(hold, "失败事务不得留下半截 hold").toBeNull();
        } finally {
          await cleanup([runId]);
        }
      },
    );
  });

  it("并发同键 reserve：只冻结一次（一个新建 + 一个重放，reserved 只加一遍）", async () => {
    await withFixture(async ({ persistence, userId, workspaceId, cleanup }) => {
      const runId = `it-${randomUUID()}`;
      const second = createPostgresPersistence({
        databaseUrl: DATABASE_URL as string,
      });
      try {
        const before = await persistence.queryOne<BalanceRow>(
          "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
          [workspaceId],
        );
        const results = (
          await Promise.all([
            createCreditRepository(persistence).flowReserveCredits({
              amount: 7,
              runId,
              userId,
              workspaceId,
            }),
            createCreditRepository(second).flowReserveCredits({
              amount: 7,
              runId,
              userId,
              workspaceId,
            }),
          ])
        ).map((result) => unwrapped(result));
        const [a, b] = results;
        if (!a || !b) throw new Error("两个并发 reserve 都应返回结果");

        // 一个新建，一个重放；两者指向同一 hold
        expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
        expect(a.holdId).toBe(b.holdId);

        const holds = await persistence.query<{ id: string }>(
          "select id from public.flow_credit_holds where workspace_id = $1 and run_id = $2",
          [workspaceId, runId],
        );
        expect(holds).toHaveLength(1);

        const balance = await persistence.queryOne<BalanceRow>(
          "select balance, reserved_balance from public.credit_balances where workspace_id = $1",
          [workspaceId],
        );
        expect(balance?.reserved_balance).toBe(
          (before?.reserved_balance ?? 0) + 7,
        );
        expect(balance?.balance).toBe(before?.balance);
      } finally {
        await second.close();
        await cleanup([runId]);
      }
    });
  });
});
