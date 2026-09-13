import type { PersistenceService } from "../persistence/types.js";

export type SubscriptionRecord = {
  plan: string;
  billing_period: string | null;
  lemon_squeezy_subscription_id: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
};

/** 订阅补丁：enum / 时间列在 SQL 侧显式 cast，避免驱动的隐式推断。 */
export type SubscriptionPatch = {
  plan?: string | undefined;
  billing_period?: string | null | undefined;
  lemon_squeezy_subscription_id?: string | null | undefined;
  lemon_squeezy_customer_id?: string | null | undefined;
  lemon_squeezy_variant_id?: string | null | undefined;
  lemon_squeezy_order_id?: string | null | undefined;
  current_period_end?: string | null | undefined;
  canceled_at?: string | null | undefined;
};

export type PaymentEventInput = {
  eventId: string | null;
  eventName: string;
  payload: Record<string, unknown>;
  workspaceId: string | null;
};

/**
 * payments 聚合的数据访问（`subscriptions` / `payment_events`）。
 *
 * 三种口径：
 * - **按工作区的订阅读写**：经 `forWorkspace` 施加谓词（webhook 里的
 *   workspace 来自签名校验过的载荷或 LS 订阅 id 反查，是可信输入）。
 * - **无工作区上下文的反查**（按 `lemon_squeezy_subscription_id` 找 workspace）：
 *   走根客户端——查的就是「这条订阅属于谁」，无从先有谓词。
 * - **webhook 审计**（`payment_events`）：`workspace_id` 可空（载荷可能不带），
 *   故走根客户端；这是系统级审计追加，不是租户数据访问。
 */
export interface PaymentRepository {
  /** 按 LS 订阅 id 反查工作区（webhook 载荷未带 workspace 时的兜底）。 */
  findWorkspaceIdByLsSubscriptionId(
    lsSubscriptionId: string,
  ): Promise<string | null>;
  findSubscriptionByWorkspace(
    workspaceId: string,
  ): Promise<SubscriptionRecord | null>;
  /** 月度额度发放：锁余额行 + 写流水，同一事务（`FOR UPDATE` 防并发丢更新）。 */
  grantMonthlyCredits(input: {
    amount: number;
    description: string;
    workspaceId: string;
  }): Promise<number | null>;
  insertPaymentEvent(input: PaymentEventInput): Promise<void>;
  markPaymentEventError(eventId: string, message: string): Promise<number>;
  markPaymentEventProcessed(eventId: string): Promise<number>;
  updateSubscriptionByWorkspace(
    workspaceId: string,
    patch: SubscriptionPatch,
  ): Promise<number>;
}

const SUBSCRIPTION_COLUMNS =
  "plan, billing_period, lemon_squeezy_subscription_id, current_period_end, canceled_at";

/** enum 列需 cast；其余按文本/时间戳透传。 */
const ENUM_CASTS: Record<string, string> = {
  billing_period: "::public.billing_period",
  plan: "::public.subscription_plan",
};

const TIMESTAMP_COLUMNS = new Set(["canceled_at", "current_period_end"]);

function buildSubscriptionPatch(
  patch: SubscriptionPatch,
): { assignments: string[]; values: unknown[] } | null {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    values.push(value);
    const cast =
      ENUM_CASTS[column] ??
      (TIMESTAMP_COLUMNS.has(column) ? "::timestamptz" : "");
    assignments.push(`${column} = $${values.length}${cast}`);
  }

  if (assignments.length === 0) {
    return null;
  }

  // updated_at 由本表触发器维护？subscriptions 无该触发器，显式写。
  assignments.push("updated_at = now()");
  return { assignments, values };
}

export function createPaymentRepository(
  persistence: PersistenceService,
): PaymentRepository {
  return {
    async findWorkspaceIdByLsSubscriptionId(lsSubscriptionId) {
      const row = await persistence.queryOne<{ workspace_id: string }>(
        `select workspace_id
           from public.subscriptions
          where lemon_squeezy_subscription_id = $1`,
        [lsSubscriptionId],
      );
      return row?.workspace_id ?? null;
    },

    async findSubscriptionByWorkspace(workspaceId) {
      return persistence.forWorkspace(workspaceId).queryOne<SubscriptionRecord>(
        `select ${SUBSCRIPTION_COLUMNS}
             from public.subscriptions
            where workspace_id = :workspace`,
      );
    },

    async updateSubscriptionByWorkspace(workspaceId, patch) {
      const built = buildSubscriptionPatch(patch);
      if (!built) {
        return 0;
      }

      return persistence.forWorkspace(workspaceId).execute(
        `update public.subscriptions
            set ${built.assignments.join(", ")}
          where workspace_id = :workspace`,
        built.values,
      );
    },

    async grantMonthlyCredits(input) {
      // 余额更新与不可变流水的原子性由事务 + 行锁保证
      // （《AGENTS.md》「余额/配额变更必须在同一原子事务中提交……」）。
      return persistence.transaction(async (tx) => {
        const scoped = tx.forWorkspace(input.workspaceId);

        const balanceRow = await scoped.queryOne<{
          balance: number;
          version: number;
        }>(
          `select balance, version
             from public.credit_balances
            where workspace_id = :workspace
              for update`,
        );

        const next = (balanceRow?.balance ?? 0) + input.amount;

        if (balanceRow) {
          await scoped.execute(
            `update public.credit_balances
                set balance = $1,
                    version = $2,
                    updated_at = now()
              where workspace_id = :workspace`,
            [next, (balanceRow.version ?? 0) + 1],
          );
        } else {
          await scoped.execute(
            `insert into public.credit_balances (workspace_id, balance, version)
             values (:workspace, $1, 1)`,
            [next],
          );
        }

        await scoped.execute(
          `insert into public.credit_transactions
                  (workspace_id, transaction_type, amount, balance_after, description)
           values (:workspace, 'subscription_grant', $1, $2, $3)`,
          [input.amount, next, input.description],
        );

        return next;
      });
    },

    async insertPaymentEvent(input) {
      await persistence.query(
        `insert into public.payment_events
                (event_name, lemon_squeezy_event_id, workspace_id, payload, processed)
         values ($1, $2, $3, $4::jsonb, false)`,
        [
          input.eventName,
          input.eventId,
          input.workspaceId,
          JSON.stringify(input.payload),
        ],
      );
    },

    async markPaymentEventProcessed(eventId) {
      return persistence.execute(
        `update public.payment_events
            set processed = true
          where lemon_squeezy_event_id = $1`,
        [eventId],
      );
    },

    async markPaymentEventError(eventId, message) {
      return persistence.execute(
        `update public.payment_events
            set error_message = $2
          where lemon_squeezy_event_id = $1`,
        [eventId, message],
      );
    },
  };
}
