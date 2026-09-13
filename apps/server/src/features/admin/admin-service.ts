// @admin — 平台管理后台服务（FORM-10：系统供应商分发 + 计费/额度统一管理）
import type {
  AdminPlatformUsageResponse,
  AdminUserSummary,
  PlatformRole,
  SubscriptionPlan,
} from "@loomic/shared";

import type { AuthenticatedUser } from "../../supabase/user.js";
import type { ViewerRepository } from "../bootstrap/repository.js";
import type { CreditService } from "../credits/credit-service.js";
import type { AdminRepository, PlatformOverviewRow } from "./repository.js";

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

function toSummary(row: PlatformOverviewRow): AdminUserSummary {
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
  credits: CreditService;
  repository: AdminRepository;
  /** workspaces/profiles 域的数据访问（目标用户的工作区与平台角色）。 */
  workspaces: ViewerRepository;
}): AdminService {
  const { repository, workspaces } = options;

  async function fetchOverview(): Promise<PlatformOverviewRow[]> {
    return repository.fetchUsersOverview().catch(() => {
      throw new AdminServiceError(
        "admin_query_failed",
        "Unable to load platform overview.",
      );
    });
  }

  async function requirePersonalWorkspace(userId: string): Promise<string> {
    const workspace = await workspaces
      .findPersonalWorkspace(userId)
      .catch(() => null);

    if (!workspace) {
      throw new AdminServiceError(
        "user_not_found",
        "该用户尚无个人工作区，无法调整额度或套餐。",
        404,
      );
    }
    return workspace.id;
  }

  return {
    async isAdmin(userId) {
      const role = await workspaces.findPlatformRole(userId).catch(() => null);
      return role === "admin";
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
      await repository
        .adjustCredits({
          amount,
          description: description ?? "admin adjustment",
          userId,
          workspaceId,
        })
        .catch((error: unknown) => {
          throw new AdminServiceError(
            "admin_action_failed",
            `额度调整失败：${
              error instanceof Error ? error.message : "unknown"
            }`,
          );
        });
    },

    async setRole(userId, role) {
      await workspaces.updatePlatformRole(userId, role).catch(() => {
        throw new AdminServiceError("admin_action_failed", "角色更新失败。");
      });
    },

    async setPlan(userId, plan) {
      const workspaceId = await requirePersonalWorkspace(userId);
      await options.credits.updatePlan(workspaceId, plan);
    },
  };
}
