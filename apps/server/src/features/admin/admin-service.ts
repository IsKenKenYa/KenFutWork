// @admin — 平台管理后台服务（FORM-10：系统供应商分发 + 计费/额度统一管理）
import type {
  AdminPlatformUsageResponse,
  AdminUserSummary,
  PlatformRole,
  SubscriptionPlan,
} from "@loomic/shared";

import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { AuthenticatedUser } from "../../supabase/user.js";
import type { CreditService } from "../credits/credit-service.js";

export class AdminServiceError extends Error {
  readonly code:
    | "forbidden"
    | "admin_query_failed"
    | "admin_action_failed"
    | "user_not_found"
    | "invalid_action";
  readonly statusCode: number;

  constructor(
    code: AdminServiceError["code"],
    message: string,
    statusCode = 500,
  ) {
    super(message);
    this.name = "AdminServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** admin_users_overview() 的行形状（snake_case，见同名迁移）。 */
interface AdminOverviewRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  workspace_id: string | null;
  plan: string;
  balance: number;
  total_tokens: number | string;
  cost_usd: number | string;
}

export type AdminService = {
  /** 是否平台管理员（普通用户一律 false）。 */
  isAdmin(userId: string): Promise<boolean>;
  /** 路由门：非管理员抛 403（前端隐藏不是安全边界）。 */
  requireAdmin(user: AuthenticatedUser): Promise<void>;
  listUsers(): Promise<AdminUserSummary[]>;
  platformUsage(): Promise<AdminPlatformUsageResponse>;
  /** 手动调剂额度：正数发放、负数扣减。 */
  grantCredits(
    userId: string,
    amount: number,
    description?: string,
  ): Promise<void>;
  setRole(userId: string, role: PlatformRole): Promise<void>;
  setPlan(userId: string, plan: SubscriptionPlan): Promise<void>;
};

// provider_instances / profiles 的 role 列未纳入生成类型，走宽松访问（仓库既有做法）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAny = (client: unknown): any => client as any;

function toSummary(row: AdminOverviewRow): AdminUserSummary {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role === "admin" ? "admin" : "user",
    workspaceId: row.workspace_id,
    plan: row.plan as SubscriptionPlan,
    balance: Number(row.balance ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
  };
}

export function createAdminService(options: {
  getAdminClient: () => AdminSupabaseClient;
  credits: CreditService;
}): AdminService {
  async function fetchOverview(): Promise<AdminOverviewRow[]> {
    const admin = options.getAdminClient();
    const { data, error } = await asAny(admin).rpc("admin_users_overview");
    if (error) {
      throw new AdminServiceError(
        "admin_query_failed",
        "Unable to load platform overview.",
      );
    }
    return (data ?? []) as AdminOverviewRow[];
  }

  async function requirePersonalWorkspace(userId: string): Promise<string> {
    const admin = options.getAdminClient();
    const { data, error } = await asAny(admin)
      .from("workspaces")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("type", "personal")
      .maybeSingle();
    if (error) {
      throw new AdminServiceError(
        "admin_query_failed",
        "Unable to resolve user workspace.",
      );
    }
    const workspaceId = (data as { id: string } | null)?.id;
    if (!workspaceId) {
      throw new AdminServiceError(
        "user_not_found",
        "该用户尚无个人工作区，无法调整额度或套餐。",
        404,
      );
    }
    return workspaceId;
  }

  return {
    async isAdmin(userId) {
      const admin = options.getAdminClient();
      const { data, error } = await asAny(admin)
        .from("profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();
      if (error || !data) return false;
      return (data as { role: string | null }).role === "admin";
    },

    async requireAdmin(user) {
      if (!(await this.isAdmin(user.id))) {
        throw new AdminServiceError("forbidden", "需要平台管理员权限。", 403);
      }
    },

    async listUsers() {
      const rows = await fetchOverview();
      return rows.map(toSummary);
    },

    async platformUsage() {
      const users = (await fetchOverview()).map(toSummary);
      const totals = users.reduce(
        (acc, user) => ({
          inputTokens: acc.inputTokens,
          outputTokens: acc.outputTokens,
          // 汇总口径用 total_tokens（input+output），明细行不拆列
          totalTokens: acc.totalTokens + user.totalTokens,
          costUsd: acc.costUsd + user.costUsd,
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      );
      return {
        totals,
        byUser: users
          .filter((user) => user.totalTokens > 0)
          .map((user) => ({
            userId: user.userId,
            email: user.email,
            totalTokens: user.totalTokens,
            costUsd: user.costUsd,
          })),
      };
    },

    async grantCredits(userId, amount, description) {
      const workspaceId = await requirePersonalWorkspace(userId);
      const admin = options.getAdminClient();
      const { error } = await asAny(admin).rpc("admin_adjust_credits", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_amount: amount,
        p_description: description ?? "admin adjustment",
      });
      if (error) {
        throw new AdminServiceError(
          "admin_action_failed",
          `额度调整失败：${error.message ?? "unknown"}`,
        );
      }
    },

    async setRole(userId, role) {
      const admin = options.getAdminClient();
      const { error } = await asAny(admin)
        .from("profiles")
        .update({ role })
        .eq("id", userId);
      if (error) {
        throw new AdminServiceError("admin_action_failed", "角色更新失败。");
      }
    },

    async setPlan(userId, plan) {
      const workspaceId = await requirePersonalWorkspace(userId);
      await options.credits.updatePlan(workspaceId, plan);
    },
  };
}
