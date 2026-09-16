import { describe, expect, it } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { CreditServiceError, createCreditService } from "./credit-service.js";
import { type CreditRepository, createCreditRepository } from "./repository.js";
import { createTierGuard, TierGuardError } from "./tier-guard.js";

const WORKSPACE_ID = "ws-1";
const USER_ID = "user-1";

type FakeResult = { rowCount: number | null; rows: unknown[] } | Error;

function createRunner(
  respond: (text: string, values: unknown[]) => FakeResult = () => ({
    rowCount: 0,
    rows: [],
  }),
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];

  const run = (text: string, values: unknown[]) => {
    calls.push({ text, values });
    const result = respond(text, values);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  const runner: PostgresQueryRunner = {
    async query(text, values) {
      return run(text, values);
    },
    async acquire() {
      return {
        query: async (text, values) => run(text, values),
        release: () => {},
      };
    },
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("credits repository（读取走工作区谓词，写入口走库函数）", () => {
  it("四张表的读取都带工作区谓词", async () => {
    const balance = createRunner(() => ({
      rowCount: 1,
      rows: [{ balance: 120 }],
    }));
    await expect(
      createCreditRepository(
        createPersistenceFromRunner(balance.runner),
      ).findBalance(WORKSPACE_ID),
    ).resolves.toBe(120);
    expect(balance.sqls()[0]).toContain(
      "from public.credit_balances where workspace_id = $1",
    );

    const plan = createRunner(() => ({ rowCount: 1, rows: [{ plan: "pro" }] }));
    await expect(
      createCreditRepository(createPersistenceFromRunner(plan.runner)).findPlan(
        WORKSPACE_ID,
      ),
    ).resolves.toBe("pro");
    expect(plan.sqls()[0]).toContain(
      "from public.subscriptions where workspace_id = $1",
    );

    const claimed = createRunner(() => ({
      rowCount: 1,
      rows: [{ id: "c-1" }],
    }));
    await expect(
      createCreditRepository(
        createPersistenceFromRunner(claimed.runner),
      ).hasClaimedToday(WORKSPACE_ID, "2026-09-13"),
    ).resolves.toBe(true);
    expect(claimed.sqls()[0]).toContain("and claim_date = $1");
    expect(claimed.calls[0]?.values).toEqual(["2026-09-13", WORKSPACE_ID]);

    const tx = createRunner(() => ({ rowCount: 1, rows: [{ id: "t-1" }] }));
    await createCreditRepository(
      createPersistenceFromRunner(tx.runner),
    ).listTransactions(WORKSPACE_ID, 20);
    expect(tx.sqls()[0]).toContain("order by created_at desc limit $1");
    expect(tx.calls[0]?.values).toEqual([20, WORKSPACE_ID]);

    const sub = createRunner(() => ({ rowCount: 1, rows: [{ plan: "free" }] }));
    await createCreditRepository(
      createPersistenceFromRunner(sub.runner),
    ).findSubscription(WORKSPACE_ID);
    expect(sub.sqls()[0]).toContain(
      "from public.subscriptions where workspace_id = $1",
    );
    expect(sub.sqls()[0]).toContain("canceled_at");
  });

  it("取消/退还/聊天扣费的库函数调用把工作区放首位参数", async () => {
    const deduct = createRunner(() => ({
      rowCount: 1,
      rows: [{ tx_id: "tx-1" }],
    }));
    await expect(
      createCreditRepository(
        createPersistenceFromRunner(deduct.runner),
      ).deductCredits({
        amount: 5,
        description: "生成",
        jobId: "job-1",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toBe("tx-1");
    expect(deduct.sqls()[0]).toBe(
      "select public.deduct_credits($1, $2, $3, $4, $5) as tx_id",
    );
    expect(deduct.calls[0]?.values).toEqual([
      WORKSPACE_ID,
      USER_ID,
      5,
      "job-1",
      "生成",
    ]);

    const chat = createRunner(() => ({
      rowCount: 1,
      rows: [{ tx_id: "tx-2" }],
    }));
    await createCreditRepository(
      createPersistenceFromRunner(chat.runner),
    ).deductChatCredits({
      amount: 3,
      runId: "run-1",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(chat.calls[0]?.values).toEqual([
      WORKSPACE_ID,
      USER_ID,
      3,
      "run-1",
      null,
    ]);

    const refund = createRunner(() => ({
      rowCount: 1,
      rows: [{ tx_id: "tx-3" }],
    }));
    await createCreditRepository(
      createPersistenceFromRunner(refund.runner),
    ).refundCredits({
      amount: 5,
      jobId: null,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(refund.sqls()[0]).toBe(
      "select public.refund_credits($1, $2, $3, $4, $5) as tx_id",
    );
  });

  it("每日领取返回布尔；套餐额度发放需 cast enum 参数", async () => {
    const claim = createRunner(() => ({
      rowCount: 1,
      rows: [{ claimed: true }],
    }));
    await expect(
      createCreditRepository(
        createPersistenceFromRunner(claim.runner),
      ).claimDailyCredits(WORKSPACE_ID, 50),
    ).resolves.toBe(true);
    expect(claim.sqls()[0]).toBe(
      "select public.claim_daily_credits($1, $2) as claimed",
    );

    const grant = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createCreditRepository(
      createPersistenceFromRunner(grant.runner),
    ).grantPlanCredits(WORKSPACE_ID, "ultra", 2000);
    expect(grant.sqls()[0]).toBe(
      "select public.grant_plan_credits($1, $2::public.subscription_plan, $3)",
    );
  });
});

function createFakeRepository(
  overrides: Partial<CreditRepository> = {},
): CreditRepository {
  return {
    adjustCredits: async () => "tx-adj",
    claimDailyCredits: async () => true,
    deductChatCredits: async () => "tx-chat",
    deductCredits: async () => "tx-deduct",
    findBalance: async () => 120,
    findPlan: async () => "free",
    findSubscription: async () => null,
    grantPlanCredits: async () => {},
    hasClaimedToday: async () => false,
    listTransactions: async () => [],
    refundCredits: async () => "tx-refund",
    ...overrides,
  };
}

function buildService(overrides: Partial<CreditRepository> = {}) {
  return createCreditService({ repository: createFakeRepository(overrides) });
}

describe("credit service", () => {
  it("余额聚合：缺行落 0/free/false，今日领取状态查询失败按未领取", async () => {
    await expect(buildService().getBalance(WORKSPACE_ID)).resolves.toEqual({
      balance: 120,
      plan: "free",
      dailyClaimed: false,
    });

    const empty = buildService({
      findBalance: async () => null,
      findPlan: async () => null,
      hasClaimedToday: async () => {
        throw new Error("boom");
      },
    });
    await expect(empty.getBalance(WORKSPACE_ID)).resolves.toEqual({
      balance: 0,
      plan: "free",
      dailyClaimed: false,
    });
  });

  it("余额/套餐查询失败报 credit_query_failed（不泄露驱动细节）", async () => {
    const service = buildService({
      findBalance: async () => {
        throw new Error("permission denied for table credit_balances");
      },
    });

    const error = await service
      .getBalance(WORKSPACE_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CreditServiceError);
    expect(error).toMatchObject({
      code: "credit_query_failed",
      statusCode: 500,
    });
    expect((error as Error).message).not.toContain("permission denied");
  });

  it("扣费：成功返回交易 id；INSUFFICIENT_CREDITS 映射 402；其它 500", async () => {
    await expect(
      buildService().deductCredits(WORKSPACE_ID, USER_ID, 5, "job-1", "生成"),
    ).resolves.toBe("tx-deduct");

    const insufficient = buildService({
      deductCredits: async () => {
        throw new Error("INSUFFICIENT_CREDITS: balance 3 < 5");
      },
    });
    await expect(
      insufficient.deductCredits(WORKSPACE_ID, USER_ID, 5),
    ).rejects.toMatchObject({ code: "insufficient_credits", statusCode: 402 });

    const failed = buildService({
      deductCredits: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(
      failed.deductCredits(WORKSPACE_ID, USER_ID, 5),
    ).rejects.toMatchObject({ code: "credit_deduct_failed", statusCode: 500 });
  });

  it("聊天扣费与管理员调剂各自的错误码映射", async () => {
    await expect(
      buildService().deductChatCredits(WORKSPACE_ID, USER_ID, 3, "run-1"),
    ).resolves.toBe("tx-chat");

    const chatInsufficient = buildService({
      deductChatCredits: async () => {
        throw new Error("INSUFFICIENT_CREDITS");
      },
    });
    await expect(
      chatInsufficient.deductChatCredits(WORKSPACE_ID, USER_ID, 3, "run-1"),
    ).rejects.toMatchObject({ code: "insufficient_credits", statusCode: 402 });

    const adjustInsufficient = buildService({
      adjustCredits: async () => {
        throw new Error("INSUFFICIENT_CREDITS");
      },
    });
    const error = await adjustInsufficient
      .adminAdjustCredits(WORKSPACE_ID, USER_ID, -999)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "insufficient_credits",
      statusCode: 402,
    });
    expect((error as Error).message).toContain("exceeds current balance");
  });

  it("退还失败报 credit_refund_failed", async () => {
    const service = buildService({
      refundCredits: async () => {
        throw new Error("no such job");
      },
    });
    await expect(
      service.refundCredits(WORKSPACE_ID, USER_ID, 5, "job-1"),
    ).rejects.toMatchObject({ code: "credit_refund_failed", statusCode: 500 });
  });

  it("每日领取：库函数返回 false 即未领取；成功后回读余额", async () => {
    await expect(
      buildService().claimDailyCredits(WORKSPACE_ID),
    ).resolves.toEqual({
      success: true,
      balance: 120,
    });

    const alreadyClaimed = buildService({
      claimDailyCredits: async () => false,
    });
    await expect(
      alreadyClaimed.claimDailyCredits(WORKSPACE_ID),
    ).resolves.toEqual({ success: false });

    const failing = buildService({
      claimDailyCredits: async () => {
        throw new Error("deadlock detected");
      },
    });
    await expect(failing.claimDailyCredits(WORKSPACE_ID)).rejects.toMatchObject(
      { code: "credit_claim_failed", statusCode: 500 },
    );
  });

  it("交易台账限幅在 [1,100]", async () => {
    const seen: number[] = [];
    const service = buildService({
      listTransactions: async (_workspaceId, limit) => {
        seen.push(limit);
        return [];
      },
    });

    await service.getTransactions(WORKSPACE_ID, 0);
    await service.getTransactions(WORKSPACE_ID, 1000);
    await service.getTransactions(WORKSPACE_ID);
    expect(seen).toEqual([1, 100, 20]);
  });

  it("套餐读取把可空字段映射为 null", async () => {
    const service = buildService({
      findSubscription: async () => ({
        billing_period: null,
        canceled_at: null,
        current_period_end: null,
        current_period_start: null,
        plan: "pro",
        stripe_customer_id: "cus_1",
        stripe_subscription_id: null,
      }),
    });

    await expect(service.getSubscription(WORKSPACE_ID)).resolves.toEqual({
      plan: "pro",
      billingPeriod: null,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      canceledAt: null,
    });
  });

  it("改套餐走库函数并带该套餐的月度额度", async () => {
    const calls: Array<[string, string, number]> = [];
    const service = buildService({
      grantPlanCredits: async (workspaceId, plan, credits) => {
        calls.push([workspaceId, plan, credits]);
      },
    });

    await service.updatePlan(WORKSPACE_ID, "ultra");
    const { PLAN_CONFIGS } = await import("@kenfutwork/shared");
    expect(calls).toEqual([
      [WORKSPACE_ID, "ultra", PLAN_CONFIGS.ultra.monthlyCredits],
    ]);

    const failing = buildService({
      grantPlanCredits: async () => {
        throw new Error("row locked");
      },
    });
    await expect(failing.updatePlan(WORKSPACE_ID, "pro")).rejects.toMatchObject(
      { code: "credit_plan_update_failed", statusCode: 500 },
    );
  });
});

describe("tier guard（并发上限）", () => {
  it("未达上限放行，达到上限抛 429 concurrency_limit", async () => {
    const { PLAN_CONFIGS } = await import("@kenfutwork/shared");
    const max = PLAN_CONFIGS.free.maxConcurrentJobs;

    await expect(
      createTierGuard({
        countActiveJobs: async () => max - 1,
      }).checkConcurrency(WORKSPACE_ID, "free"),
    ).resolves.toBeUndefined();

    const error = await createTierGuard({
      countActiveJobs: async () => max,
    })
      .checkConcurrency(WORKSPACE_ID, "free")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TierGuardError);
    expect(error).toMatchObject({ code: "concurrency_limit", statusCode: 429 });
  });

  it("计数查询失败时 fail open（只记日志，不放行拦死主链路）", async () => {
    const guard = createTierGuard({
      countActiveJobs: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(
      guard.checkConcurrency(WORKSPACE_ID, "free"),
    ).resolves.toBeUndefined();
  });
});
