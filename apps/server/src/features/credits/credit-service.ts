// @credits-system — Core credit operations: balance queries, deductions, refunds, grants, plan updates
import type {
  BillingPeriod,
  CreditTransaction,
  SubscriptionPlan,
} from "@kenfutwork/shared";
import { PLAN_CONFIGS } from "@kenfutwork/shared";

import type { CreditRepository } from "./repository.js";

// ── Error ────────────────────────────────────────────────────

export class CreditServiceError extends Error {
  readonly statusCode: number;
  readonly code:
    | "insufficient_credits"
    | "credit_query_failed"
    | "credit_claim_failed"
    | "credit_deduct_failed"
    | "credit_refund_failed"
    | "credit_plan_update_failed";

  constructor(
    code: CreditServiceError["code"],
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.name = "CreditServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Types ────────────────────────────────────────────────────

export type BalanceInfo = {
  balance: number;
  plan: SubscriptionPlan;
  dailyClaimed: boolean;
};

export type SubscriptionInfo = {
  plan: SubscriptionPlan;
  billingPeriod: BillingPeriod | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
};

export type CreditService = {
  getBalance(workspaceId: string): Promise<BalanceInfo>;
  deductCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    jobId?: string,
    description?: string,
  ): Promise<string>;
  /**
   * 平台池聊天扣费（FORM-10）：与生成扣费分离，台账类型 chat_deduct，
   * 便于后台区分「生成消耗」与「平台池对话消耗」。
   */
  deductChatCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    runId: string,
    description?: string,
  ): Promise<string>;
  /** 管理员手动调剂额度（正发负扣，台账类型 admin_adjustment）。 */
  adminAdjustCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    description?: string,
  ): Promise<string>;
  refundCredits(
    workspaceId: string,
    userId: string,
    amount: number,
    jobId: string,
    description?: string,
  ): Promise<string>;
  claimDailyCredits(
    workspaceId: string,
  ): Promise<{ success: boolean; balance?: number }>;
  getTransactions(
    workspaceId: string,
    limit?: number,
  ): Promise<CreditTransaction[]>;
  getSubscription(workspaceId: string): Promise<SubscriptionInfo>;
  updatePlan(workspaceId: string, plan: SubscriptionPlan): Promise<void>;
};

// ── Factory ──────────────────────────────────────────────────

export function createCreditService(options: {
  repository: CreditRepository;
}): CreditService {
  const { repository } = options;

  /** 「额度不足」由库函数以异常抛出，消息含 INSUFFICIENT_CREDITS。 */
  function mapDeductError(error: unknown, action: string): CreditServiceError {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("INSUFFICIENT_CREDITS")) {
      return new CreditServiceError(
        "insufficient_credits",
        "Not enough credits to perform this action.",
        402,
      );
    }
    return new CreditServiceError(
      "credit_deduct_failed",
      `Failed to ${action}: ${message}`,
      500,
    );
  }

  return {
    async getBalance(workspaceId) {
      // 余额与套餐查询失败即报错；今日领取状态查询失败按「未领取」处理（与旧行为一致）。
      const [balance, plan, dailyClaimed] = await Promise.all([
        repository.findBalance(workspaceId),
        repository.findPlan(workspaceId),
        repository
          .hasClaimedToday(workspaceId, new Date().toISOString().slice(0, 10))
          .catch(() => false),
      ]).catch(() => {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query credit balance.",
          500,
        );
      });

      return {
        balance: balance ?? 0,
        plan: (plan as SubscriptionPlan) ?? "free",
        dailyClaimed,
      };
    },

    async deductCredits(workspaceId, userId, amount, jobId, description) {
      const txId = await repository
        .deductCredits({
          amount,
          description,
          jobId,
          userId,
          workspaceId,
        })
        .catch((error: unknown) => {
          throw mapDeductError(error, "deduct credits");
        });

      return txId as string;
    },

    async deductChatCredits(workspaceId, userId, amount, runId, description) {
      const txId = await repository
        .deductChatCredits({
          amount,
          description,
          runId,
          userId,
          workspaceId,
        })
        .catch((error: unknown) => {
          throw mapDeductError(error, "deduct chat credits");
        });

      return txId as string;
    },

    async adminAdjustCredits(workspaceId, userId, amount, description) {
      const txId = await repository
        .adjustCredits({ amount, description, userId, workspaceId })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (message.includes("INSUFFICIENT_CREDITS")) {
            throw new CreditServiceError(
              "insufficient_credits",
              "Deduction exceeds current balance.",
              402,
            );
          }
          throw new CreditServiceError(
            "credit_deduct_failed",
            `Failed to adjust credits: ${message}`,
            500,
          );
        });

      return txId as string;
    },

    async refundCredits(workspaceId, userId, amount, jobId, description) {
      const txId = await repository
        .refundCredits({ amount, description, jobId, userId, workspaceId })
        .catch((error: unknown) => {
          throw new CreditServiceError(
            "credit_refund_failed",
            `Failed to refund credits: ${
              error instanceof Error ? error.message : String(error)
            }`,
            500,
          );
        });

      return txId as string;
    },

    async claimDailyCredits(workspaceId) {
      const plan =
        (await repository.findPlan(workspaceId).catch(() => {
          throw new CreditServiceError(
            "credit_claim_failed",
            "Failed to query subscription.",
            500,
          );
        })) ?? "free";

      const config = PLAN_CONFIGS[plan as SubscriptionPlan];

      if (config.dailyCredits <= 0) {
        return { success: false };
      }

      const claimed = await repository
        .claimDailyCredits(workspaceId, config.dailyCredits)
        .catch((error: unknown) => {
          throw new CreditServiceError(
            "credit_claim_failed",
            `Failed to claim daily credits: ${
              error instanceof Error ? error.message : String(error)
            }`,
            500,
          );
        });

      if (!claimed) {
        return { success: false };
      }

      const balance = await repository
        .findBalance(workspaceId)
        .catch(() => null);
      return { success: true, balance: balance ?? 0 };
    },

    async getTransactions(workspaceId, limit = 20) {
      const safeLimit = Math.min(Math.max(limit, 1), 100);

      const rows = await repository
        .listTransactions(workspaceId, safeLimit)
        .catch(() => {
          throw new CreditServiceError(
            "credit_query_failed",
            "Failed to query transactions.",
            500,
          );
        });

      return rows as CreditTransaction[];
    },

    async getSubscription(workspaceId) {
      const row = await repository.findSubscription(workspaceId).catch(() => {
        throw new CreditServiceError(
          "credit_query_failed",
          "Failed to query subscription.",
          500,
        );
      });

      return {
        plan: (row?.plan as SubscriptionPlan) ?? "free",
        billingPeriod: (row?.billing_period as BillingPeriod) ?? null,
        stripeCustomerId: row?.stripe_customer_id ?? null,
        stripeSubscriptionId: row?.stripe_subscription_id ?? null,
        currentPeriodStart: row?.current_period_start ?? null,
        currentPeriodEnd: row?.current_period_end ?? null,
        canceledAt: row?.canceled_at ?? null,
      };
    },

    async updatePlan(workspaceId, plan) {
      const config = PLAN_CONFIGS[plan];

      // 原子「改套餐 + 发额度」由库函数承担（FOR UPDATE 行锁，避免读改写竞态）。
      await repository
        .grantPlanCredits(workspaceId, plan, config.monthlyCredits)
        .catch((error: unknown) => {
          throw new CreditServiceError(
            "credit_plan_update_failed",
            `Failed to update plan: ${
              error instanceof Error ? error.message : String(error)
            }`,
            500,
          );
        });
    },
  };
}
