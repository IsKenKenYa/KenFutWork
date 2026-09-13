import type { PersistenceService } from "../persistence/types.js";

/** `admin_users_overview()` 的行形状（snake_case，见同名迁移）。 */
export type PlatformOverviewRow = {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  workspace_id: string | null;
  plan: string;
  /** `integer` 列。 */
  balance: number;
  /** `bigint` 列：驱动回来是字符串，归一为 number。 */
  total_tokens: number;
  /** `numeric` 列：驱动回来是字符串，归一为 number。 */
  cost_usd: number;
};

export type AdjustCreditsInput = {
  amount: number;
  description: string;
  userId: string;
  workspaceId: string;
};

type RawOverviewRow = Omit<PlatformOverviewRow, "cost_usd" | "total_tokens"> & {
  total_tokens: string | number;
  cost_usd: string | number;
};

/**
 * admin 聚合的数据访问（平台级，跨工作区）。
 *
 * 平台总览与额度调剂都是**跨租户的系统操作**，没有「当前工作区」可言，
 * 故走根客户端；隔离边界是 HTTP 层的管理员门（`requireAdmin` 403），
 * 不是工作区谓词——调用方必须已经过管理员判定。
 */
export interface AdminRepository {
  /** 手动调剂额度：正数发放、负数扣减；返回交易 id。 */
  adjustCredits(input: AdjustCreditsInput): Promise<string | null>;
  fetchUsersOverview(): Promise<PlatformOverviewRow[]>;
}

export function createAdminRepository(
  persistence: PersistenceService,
): AdminRepository {
  return {
    async fetchUsersOverview() {
      const rows = await persistence.query<RawOverviewRow>(
        "select * from public.admin_users_overview()",
      );

      return rows.map((row) => ({
        balance: Number(row.balance ?? 0),
        cost_usd: Number(row.cost_usd ?? 0),
        display_name: row.display_name,
        email: row.email,
        plan: row.plan,
        role: row.role,
        total_tokens: Number(row.total_tokens ?? 0),
        user_id: row.user_id,
        workspace_id: row.workspace_id,
      }));
    },

    async adjustCredits(input) {
      // 可凭空发分的库函数，参数已显式携带身份（不依赖 auth.uid）。
      const row = await persistence.queryOne<{ tx_id: string }>(
        "select public.admin_adjust_credits($1, $2, $3, $4) as tx_id",
        [input.workspaceId, input.userId, input.amount, input.description],
      );
      return row?.tx_id ?? null;
    },
  };
}
