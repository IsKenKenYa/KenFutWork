import { describe, expect, it, vi } from "vitest";

import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import type { LemonSqueezyClient } from "./lemon-squeezy-client.js";
import {
  createPaymentService,
  PaymentServiceError,
  type WebhookPayload,
} from "./payment-service.js";
import {
  createPaymentRepository,
  type PaymentRepository,
} from "./repository.js";

const WORKSPACE_ID = "33333333-3333-3333-3333-333333333333";
const LS_SUB_ID = "ls-sub-1";

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
    async acquireSession() {
      throw new Error("此查询夹具不提供真实执行宿主会话。");
    },
    async end() {},
  };

  return {
    calls,
    runner,
    sqls: () => calls.map((c) => c.text.replace(/\s+/g, " ").trim()),
  };
}

describe("payments repository（订阅与 webhook 审计）", () => {
  it("订阅读取与更新都按工作区限定；enum/时间列显式 cast", async () => {
    const read = createRunner(() => ({
      rowCount: 1,
      rows: [{ plan: "pro", lemon_squeezy_subscription_id: LS_SUB_ID }],
    }));
    await createPaymentRepository(
      createPersistenceFromRunner(read.runner),
    ).findSubscriptionByWorkspace(WORKSPACE_ID);
    expect(read.sqls()[0]).toContain(
      "from public.subscriptions where workspace_id = $1",
    );

    const write = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createPaymentRepository(
      createPersistenceFromRunner(write.runner),
    ).updateSubscriptionByWorkspace(WORKSPACE_ID, {
      billing_period: "monthly",
      canceled_at: null,
      current_period_end: "2026-10-13T00:00:00.000Z",
      lemon_squeezy_subscription_id: LS_SUB_ID,
      plan: "pro",
    });

    // 占位符按补丁键的书写顺序编号；工作区由 :workspace 追加为末位参数。
    const sql = write.sqls()[0] ?? "";
    expect(sql).toContain("billing_period = $1::public.billing_period");
    expect(sql).toContain("canceled_at = $2::timestamptz");
    expect(sql).toContain("current_period_end = $3::timestamptz");
    expect(sql).toContain("lemon_squeezy_subscription_id = $4");
    expect(sql).toContain("plan = $5::public.subscription_plan");
    expect(sql).toContain("updated_at = now()");
    expect(sql).toContain("where workspace_id = $6");
    expect(write.calls[0]?.values).toEqual([
      "monthly",
      null,
      "2026-10-13T00:00:00.000Z",
      LS_SUB_ID,
      "pro",
      WORKSPACE_ID,
    ]);
  });

  it("空补丁不下发语句", async () => {
    const { calls, runner } = createRunner();
    await expect(
      createPaymentRepository(
        createPersistenceFromRunner(runner),
      ).updateSubscriptionByWorkspace(WORKSPACE_ID, {}),
    ).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("按 LS 订阅 id 反查工作区走根客户端（此时尚无工作区谓词可言）", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [{ workspace_id: WORKSPACE_ID }],
    }));

    await expect(
      createPaymentRepository(
        createPersistenceFromRunner(runner),
      ).findWorkspaceIdByLsSubscriptionId(LS_SUB_ID),
    ).resolves.toBe(WORKSPACE_ID);
    expect(calls[0]?.text).toContain(
      "where lemon_squeezy_subscription_id = $1",
    );
    expect(calls[0]?.values).toEqual([LS_SUB_ID]);
  });

  it("月度额度发放：同一事务内锁余额行 + 写流水", async () => {
    const { calls, runner } = createRunner((text) =>
      text.includes("select balance")
        ? { rowCount: 1, rows: [{ balance: 100, version: 3 }] }
        : { rowCount: 1, rows: [] },
    );

    await expect(
      createPaymentRepository(
        createPersistenceFromRunner(runner),
      ).grantMonthlyCredits({
        amount: 5000,
        description: "pro plan — monthly credits granted",
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toBe(5100);

    const sqls = calls.map((c) => c.text.replace(/\s+/g, " ").trim());
    expect(sqls[0]).toBe("begin");
    expect(sqls.at(-1)).toBe("commit");
    // 余额行加锁读取（防并发丢更新）
    expect(sqls[1]).toContain("for update");
    // 余额更新带 version 递增
    const balanceUpdate = sqls.find((s) =>
      s.startsWith("update public.credit_balances"),
    );
    expect(balanceUpdate).toContain("version = $2");
    expect(balanceUpdate).toContain("where workspace_id = $3");
    // 流水与余额同事务
    const ledger = sqls.find((s) =>
      s.startsWith("insert into public.credit_transactions"),
    );
    expect(ledger).toContain("'subscription_grant'");
    // 业务参数 $1..$3，工作区由 :workspace 追加为 $4
    expect(ledger).toContain("values ($4, 'subscription_grant', $1, $2, $3)");
  });

  it("余额行不存在时同事务内补建", async () => {
    const { calls, runner } = createRunner((text) =>
      text.includes("select balance")
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [] },
    );

    await expect(
      createPaymentRepository(
        createPersistenceFromRunner(runner),
      ).grantMonthlyCredits({
        amount: 100,
        description: "d",
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toBe(100);

    const sqls = calls.map((c) => c.text.replace(/\s+/g, " ").trim());
    expect(
      sqls.some((s) => s.startsWith("insert into public.credit_balances")),
    ).toBe(true);
  });

  it("webhook 审计：追加事件、按事件 id 标记已处理/错误", async () => {
    const insert = createRunner();
    await createPaymentRepository(
      createPersistenceFromRunner(insert.runner),
    ).insertPaymentEvent({
      eventId: "evt-1",
      eventName: "subscription_created",
      payload: { meta: { event_name: "subscription_created" } },
      workspaceId: WORKSPACE_ID,
    });
    expect(insert.sqls()[0]).toContain("insert into public.payment_events");
    expect(insert.sqls()[0]).toContain("$4::jsonb");
    // payment_events.workspace_id 可空（载荷可能不带），故走根客户端
    expect(insert.sqls()[0]).not.toContain(":workspace");

    const processed = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createPaymentRepository(
      createPersistenceFromRunner(processed.runner),
    ).markPaymentEventProcessed("evt-1");
    expect(processed.sqls()[0]).toContain("set processed = true");
    expect(processed.calls[0]?.values).toEqual(["evt-1"]);

    const failed = createRunner(() => ({ rowCount: 1, rows: [] }));
    await createPaymentRepository(
      createPersistenceFromRunner(failed.runner),
    ).markPaymentEventError("evt-1", "boom");
    expect(failed.calls[0]?.values).toEqual(["evt-1", "boom"]);
  });
});

// ── service ─────────────────────────────────────────────────

const SUBSCRIPTION_ROW = {
  plan: "pro",
  billing_period: "monthly",
  lemon_squeezy_subscription_id: LS_SUB_ID,
  current_period_end: "2026-10-13T00:00:00+00:00",
  canceled_at: null,
};

function createFakeRepository(
  overrides: Partial<PaymentRepository> = {},
): PaymentRepository {
  return {
    findSubscriptionByWorkspace: async () => SUBSCRIPTION_ROW,
    findWorkspaceIdByLsSubscriptionId: async () => WORKSPACE_ID,
    grantMonthlyCredits: async () => 100,
    insertPaymentEvent: async () => {},
    markPaymentEventError: async () => 1,
    markPaymentEventProcessed: async () => 1,
    updateSubscriptionByWorkspace: async () => 1,
    ...overrides,
  };
}

function createFakeLs(
  overrides: Partial<LemonSqueezyClient> = {},
): LemonSqueezyClient {
  return {
    cancelSubscription: vi.fn(async () => {}),
    createCheckout: vi.fn(async () => ({ checkoutUrl: "https://ls.test/co" })),
    getSubscription: vi.fn(async () => ({
      attributes: { urls: { customer_portal: "https://ls.test/portal" } },
    })),
    updateSubscription: vi.fn(async () => {}),
    ...overrides,
  } as unknown as LemonSqueezyClient;
}

function buildService(
  options: {
    repository?: Partial<PaymentRepository>;
    lemonSqueezy?: LemonSqueezyClient;
  } = {},
) {
  return createPaymentService({
    lemonSqueezy: options.lemonSqueezy ?? createFakeLs(),
    repository: createFakeRepository(options.repository),
    variantMap: { pro_monthly: "123" },
    webOrigin: "https://app.test",
  });
}

function payload(
  attrs: Record<string, unknown>,
  workspaceId?: string,
): WebhookPayload {
  return {
    meta: {
      custom_data: workspaceId ? { workspace_id: workspaceId } : {},
      event_name: "test",
    },
    data: {
      attributes: attrs as never,
      id: LS_SUB_ID,
    },
  } as unknown as WebhookPayload;
}

describe("payment service（webhook 处理与订阅状态）", () => {
  it("订阅状态映射含客户门户 URL；门户拉取失败可容忍", async () => {
    await expect(
      buildService().getSubscriptionStatus(WORKSPACE_ID),
    ).resolves.toEqual({
      plan: "pro",
      billingPeriod: "monthly",
      status: "active",
      lemonSqueezySubscriptionId: LS_SUB_ID,
      currentPeriodEnd: "2026-10-13T00:00:00+00:00",
      canceledAt: null,
      customerPortalUrl: "https://ls.test/portal",
    });

    const noPortal = buildService({
      lemonSqueezy: createFakeLs({
        getSubscription: vi.fn(async () => {
          throw new Error("LS down");
        }),
      }),
    });
    await expect(
      noPortal.getSubscriptionStatus(WORKSPACE_ID),
    ).resolves.toMatchObject({ customerPortalUrl: null, plan: "pro" });
  });

  it("订阅缺失时状态按 free 落回", async () => {
    const service = buildService({
      repository: { findSubscriptionByWorkspace: async () => null },
    });
    await expect(
      service.getSubscriptionStatus(WORKSPACE_ID),
    ).resolves.toMatchObject({
      plan: "free",
      billingPeriod: null,
      status: null,
      lemonSqueezySubscriptionId: null,
    });
  });

  it("取消订阅：无 LS 订阅即 404；否则调 LS 取消", async () => {
    const missing = buildService({
      repository: { findSubscriptionByWorkspace: async () => null },
    });
    await expect(
      missing.cancelSubscription(WORKSPACE_ID),
    ).rejects.toMatchObject({
      code: "subscription_not_found",
      statusCode: 404,
    });

    const ls = createFakeLs();
    await buildService({ lemonSqueezy: ls }).cancelSubscription(WORKSPACE_ID);
    expect(ls.cancelSubscription).toHaveBeenCalledWith(LS_SUB_ID);
  });

  it("改套餐：变体未配置即 400，且不调 LS", async () => {
    const ls = createFakeLs();
    const service = buildService({ lemonSqueezy: ls });

    await expect(
      service.changePlan(WORKSPACE_ID, "ultra", "monthly"),
    ).rejects.toMatchObject({ code: "variant_not_found", statusCode: 400 });
    expect(ls.updateSubscription).not.toHaveBeenCalled();

    await service.changePlan(WORKSPACE_ID, "pro", "monthly");
    expect(ls.updateSubscription).toHaveBeenCalledWith(LS_SUB_ID, {
      invoice_immediately: true,
      variant_id: 123,
    });
  });

  it("webhook subscription_created：写套餐与 LS 标识，不发额度", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const grants: unknown[] = [];
    const service = buildService({
      repository: {
        grantMonthlyCredits: async (input) => {
          grants.push(input);
          return 1;
        },
        updateSubscriptionByWorkspace: async (_workspaceId, patch) => {
          updates.push(patch);
          return 1;
        },
      },
    });

    await service.handleWebhookEvent(
      "subscription_created",
      payload(
        {
          customer_id: 7,
          order_id: 9,
          renews_at: "2026-10-13T00:00:00.000Z",
          variant_id: 123,
        },
        WORKSPACE_ID,
      ),
    );

    expect(updates).toEqual([
      {
        plan: "pro",
        billing_period: "monthly",
        lemon_squeezy_subscription_id: LS_SUB_ID,
        lemon_squeezy_customer_id: "7",
        lemon_squeezy_variant_id: "123",
        lemon_squeezy_order_id: "9",
        current_period_end: "2026-10-13T00:00:00.000Z",
        canceled_at: null,
      },
    ]);
    // 额度由 subscription_payment_success 发放
    expect(grants).toEqual([]);
  });

  it("webhook 缺 workspace 且反查不到：告警返回，不写库", async () => {
    let writes = 0;
    const service = buildService({
      repository: {
        findWorkspaceIdByLsSubscriptionId: async () => null,
        updateSubscriptionByWorkspace: async () => {
          writes += 1;
          return 1;
        },
      },
    });

    await service.handleWebhookEvent(
      "subscription_cancelled",
      payload({ ends_at: "2026-10-01T00:00:00.000Z" }),
    );
    expect(writes).toBe(0);
  });

  it("webhook subscription_cancelled：只标 canceled_at，保留套餐", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const service = buildService({
      repository: {
        updateSubscriptionByWorkspace: async (_workspaceId, patch) => {
          updates.push(patch);
          return 1;
        },
      },
    });

    await service.handleWebhookEvent(
      "subscription_cancelled",
      payload({ ends_at: "2026-10-01T00:00:00.000Z" }),
    );
    expect(updates).toEqual([{ canceled_at: "2026-10-01T00:00:00.000Z" }]);
  });

  it("webhook subscription_payment_success：更新续费期并按当前套餐发额度", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const grants: Array<{ amount: number; description: string }> = [];
    const service = buildService({
      repository: {
        grantMonthlyCredits: async (input) => {
          grants.push({ amount: input.amount, description: input.description });
          return 1;
        },
        updateSubscriptionByWorkspace: async (_workspaceId, patch) => {
          updates.push(patch);
          return 1;
        },
      },
    });

    await service.handleWebhookEvent(
      "subscription_payment_success",
      payload({ renews_at: "2026-11-13T00:00:00.000Z" }, WORKSPACE_ID),
    );

    expect(updates).toEqual([
      { canceled_at: null, current_period_end: "2026-11-13T00:00:00.000Z" },
    ]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.description).toContain("monthly credits granted");
  });

  it("webhook subscription_expired：降级为 free 并清空 LS 标识", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const service = buildService({
      repository: {
        updateSubscriptionByWorkspace: async (_workspaceId, patch) => {
          updates.push(patch);
          return 1;
        },
      },
    });

    await service.handleWebhookEvent(
      "subscription_expired",
      payload({}, WORKSPACE_ID),
    );

    expect(updates).toEqual([
      {
        plan: "free",
        billing_period: null,
        lemon_squeezy_subscription_id: null,
        lemon_squeezy_customer_id: null,
        lemon_squeezy_variant_id: null,
        lemon_squeezy_order_id: null,
        current_period_end: null,
        canceled_at: null,
      },
    ]);
  });

  it("平台池/未订阅工作区调用取消仍报 404（fail loud）", async () => {
    const service = buildService({
      repository: {
        findSubscriptionByWorkspace: async () => ({
          ...SUBSCRIPTION_ROW,
          lemon_squeezy_subscription_id: null,
        }),
      },
    });
    const error = await service
      .cancelSubscription(WORKSPACE_ID)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentServiceError);
    expect(error).toMatchObject({ statusCode: 404 });
  });
});
