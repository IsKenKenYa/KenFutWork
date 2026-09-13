import type { PersistenceService } from "../persistence/types.js";

export type BalanceRow = { balance: number };
export type PlanRow = { plan: string };
export type SubscriptionRow = {
  plan: string;
  billing_period: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
};

export type CreditTransactionRow = {
  id: string;
  transaction_type: string;
  amount: number;
  balance_after: number;
  job_id: string | null;
  description: string | null;
  created_at: string;
};

export type CreditDeductInput = {
  amount: number;
  description?: string | null | undefined;
  jobId?: string | null | undefined;
  userId: string;
  workspaceId: string;
};

export type ChatDeductInput = {
  amount: number;
  description?: string | null | undefined;
  runId: string;
  userId: string;
  workspaceId: string;
};

export type AdjustCreditsInput = {
  amount: number;
  description?: string | null | undefined;
  userId: string;
  workspaceId: string;
};

export type RefundInput = {
  amount: number;
  description?: string | null | undefined;
  jobId?: string | null | undefined;
  userId: string;
  workspaceId: string;
};

/**
 * credits 聚合的数据访问（`credit_balances`/`subscriptions`/`daily_credit_claims`/
 * `credit_transactions`，四张表都带 `workspace_id`）。
 *
 * **两种口径**：
 * - **读取**（余额/套餐/今日是否已领/交易台账）：经 `forWorkspace` 施加谓词。
 * - **写入口（6 个库函数）**：`deduct_credits`/`deduct_chat_credits`/
 *   `refund_credits`/`admin_adjust_credits`/`claim_daily_credits`/
 *   `grant_plan_credits` 走根客户端，因为**原子性由库函数承担**（`FOR UPDATE`
 *   行锁 + 同事务写台账，见《AGENTS.md》「余额/配额变更必须在同一原子事务中提交
 *   余额更新与不可变交易流水」），工作区是**显式参数**、在调用点可见，故不需要
 *   `:workspace` 谓词标记；这些函数都不依赖 `auth.uid`，可经单一信任角色调用。
 */
export interface CreditRepository {
  adjustCredits(input: AdjustCreditsInput): Promise<string | null>;
  claimDailyCredits(workspaceId: string, amount: number): Promise<boolean>;
  deductChatCredits(input: ChatDeductInput): Promise<string | null>;
  deductCredits(input: CreditDeductInput): Promise<string | null>;
  findBalance(workspaceId: string): Promise<number | null>;
  findPlan(workspaceId: string): Promise<string | null>;
  findSubscription(workspaceId: string): Promise<SubscriptionRow | null>;
  grantPlanCredits(
    workspaceId: string,
    plan: string,
    credits: number,
  ): Promise<void>;
  /** 今日是否已领取（按 UTC 日期）。 */
  hasClaimedToday(workspaceId: string, claimDate: string): Promise<boolean>;
  listTransactions(
    workspaceId: string,
    limit: number,
  ): Promise<CreditTransactionRow[]>;
  refundCredits(input: RefundInput): Promise<string | null>;
}

export function createCreditRepository(
  persistence: PersistenceService,
): CreditRepository {
  return {
    async findBalance(workspaceId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<BalanceRow>(
          `select balance
             from public.credit_balances
            where workspace_id = :workspace`,
        );
      return row?.balance ?? null;
    },

    async findPlan(workspaceId) {
      const row = await persistence.forWorkspace(workspaceId).queryOne<PlanRow>(
        `select plan
           from public.subscriptions
          where workspace_id = :workspace`,
      );
      return row?.plan ?? null;
    },

    async hasClaimedToday(workspaceId, claimDate) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<{ id: string }>(
          `select id
             from public.daily_credit_claims
            where workspace_id = :workspace
              and claim_date = $1`,
          [claimDate],
        );
      return row !== null;
    },

    async listTransactions(workspaceId, limit) {
      return persistence.forWorkspace(workspaceId).query<CreditTransactionRow>(
        `select id, transaction_type, amount, balance_after, job_id, description, created_at
           from public.credit_transactions
          where workspace_id = :workspace
          order by created_at desc
          limit $1`,
        [limit],
      );
    },

    async findSubscription(workspaceId) {
      return persistence.forWorkspace(workspaceId).queryOne<SubscriptionRow>(
        `select plan, billing_period, stripe_customer_id, stripe_subscription_id,
                  current_period_start, current_period_end, canceled_at
             from public.subscriptions
            where workspace_id = :workspace`,
      );
    },

    // ── 写入口：原子性由库函数承担（工作区为显式参数） ──

    async deductCredits(input) {
      const row = await persistence.queryOne<{ tx_id: string }>(
        "select public.deduct_credits($1, $2, $3, $4, $5) as tx_id",
        [
          input.workspaceId,
          input.userId,
          input.amount,
          input.jobId ?? null,
          input.description ?? null,
        ],
      );
      return row?.tx_id ?? null;
    },

    async deductChatCredits(input) {
      const row = await persistence.queryOne<{ tx_id: string }>(
        "select public.deduct_chat_credits($1, $2, $3, $4, $5) as tx_id",
        [
          input.workspaceId,
          input.userId,
          input.amount,
          input.runId,
          input.description ?? null,
        ],
      );
      return row?.tx_id ?? null;
    },

    async adjustCredits(input) {
      const row = await persistence.queryOne<{ tx_id: string }>(
        "select public.admin_adjust_credits($1, $2, $3, $4) as tx_id",
        [
          input.workspaceId,
          input.userId,
          input.amount,
          input.description ?? null,
        ],
      );
      return row?.tx_id ?? null;
    },

    async refundCredits(input) {
      const row = await persistence.queryOne<{ tx_id: string }>(
        "select public.refund_credits($1, $2, $3, $4, $5) as tx_id",
        [
          input.workspaceId,
          input.userId,
          input.amount,
          input.jobId ?? null,
          input.description ?? null,
        ],
      );
      return row?.tx_id ?? null;
    },

    async claimDailyCredits(workspaceId, amount) {
      const row = await persistence.queryOne<{ claimed: boolean }>(
        "select public.claim_daily_credits($1, $2) as claimed",
        [workspaceId, amount],
      );
      return row?.claimed === true;
    },

    async grantPlanCredits(workspaceId, plan, credits) {
      // p_plan 是 enum 参数，文本参数需显式 cast。
      await persistence.query(
        "select public.grant_plan_credits($1, $2::public.subscription_plan, $3)",
        [workspaceId, plan, credits],
      );
    },
  };
}
