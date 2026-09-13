import { describe, expect, it } from "vitest";

import { AdminServiceError, createAdminService } from "./admin-service.js";

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const WORKSPACE_ID = "33333333-3333-3333-3333-333333333333";

const adminUser = {
  accessToken: "token",
  email: "admin@example.com",
  id: ADMIN_ID,
  userMetadata: {},
};

/** 最小假 admin client：支持 from().select().eq()...maybeSingle() / update().eq() / rpc()。 */
function fakeAdmin(options: {
  role?: string | null;
  workspaceId?: string | null;
  overview?: unknown[];
  rpcCalls?: Array<{ name: string; args: unknown }>;
  rpcError?: { message: string } | null;
}) {
  /** select 链：eq 可重复，末端 maybeSingle/single 出结果。 */
  const chain = (result: unknown) => {
    const node: Record<string, unknown> = {};
    node.eq = () => node;
    node.maybeSingle = async () => ({ data: result, error: null });
    node.single = async () => ({ data: result, error: null });
    return node;
  };
  /** update 链：`await update(...).eq(...)` 直接落定为成功。 */
  const updateChain = () => ({ eq: async () => ({ data: null, error: null }) });
  return {
    rpc: async (name: string, args: unknown) => {
      options.rpcCalls?.push({ name, args });
      if (name === "admin_users_overview") {
        return { data: options.overview ?? [], error: null };
      }
      return { data: "tx-id", error: options.rpcError ?? null };
    },
    from: (table: string) => ({
      select: () => {
        if (table === "profiles") {
          return chain(
            options.role === undefined ? null : { role: options.role },
          );
        }
        if (table === "workspaces") {
          return chain(
            options.workspaceId === undefined
              ? null
              : { id: options.workspaceId },
          );
        }
        return chain(null);
      },
      update: () => updateChain(),
    }),
  } as never;
}

const overviewRow = {
  user_id: USER_ID,
  email: "u@example.com",
  display_name: "用户",
  role: "user",
  workspace_id: WORKSPACE_ID,
  plan: "pro",
  balance: 120,
  total_tokens: "1500",
  cost_usd: "0.25",
};

describe("admin 服务（平台管理后台）", () => {
  it("isAdmin：profiles.role='admin' 才是管理员", async () => {
    const asAdmin = createAdminService({
      getAdminClient: () => fakeAdmin({ role: "admin" }),
      credits: {} as never,
    });
    const asUser = createAdminService({
      getAdminClient: () => fakeAdmin({ role: "user" }),
      credits: {} as never,
    });
    const asMissing = createAdminService({
      getAdminClient: () => fakeAdmin({ role: null }),
      credits: {} as never,
    });
    expect(await asAdmin.isAdmin(ADMIN_ID)).toBe(true);
    expect(await asUser.isAdmin(USER_ID)).toBe(false);
    expect(await asMissing.isAdmin(USER_ID)).toBe(false);
  });

  it("requireAdmin：非管理员抛 403（前端隐藏不是安全边界）", async () => {
    const service = createAdminService({
      getAdminClient: () => fakeAdmin({ role: "user" }),
      credits: {} as never,
    });
    await expect(service.requireAdmin(adminUser)).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
  });

  it("listUsers：汇总行映射为契约（数字字符串转 number）", async () => {
    const service = createAdminService({
      getAdminClient: () => fakeAdmin({ overview: [overviewRow] }),
      credits: {} as never,
    });
    const users = await service.listUsers();
    expect(users).toEqual([
      {
        userId: USER_ID,
        email: "u@example.com",
        displayName: "用户",
        role: "user",
        workspaceId: WORKSPACE_ID,
        plan: "pro",
        balance: 120,
        totalTokens: 1500,
        costUsd: 0.25,
      },
    ]);
  });

  it("platformUsage：总览只列有用量的用户", async () => {
    const service = createAdminService({
      getAdminClient: () =>
        fakeAdmin({
          overview: [
            overviewRow,
            {
              ...overviewRow,
              user_id: ADMIN_ID,
              email: "a@x.com",
              total_tokens: 0,
              cost_usd: 0,
            },
          ],
        }),
      credits: {} as never,
    });
    const usage = await service.platformUsage();
    expect(usage.totals.totalTokens).toBe(1500);
    expect(usage.totals.costUsd).toBeCloseTo(0.25);
    expect(usage.byUser).toHaveLength(1);
    expect(usage.byUser[0]?.email).toBe("u@example.com");
  });

  it("grantCredits：解析个人工作区后走 admin_adjust_credits", async () => {
    const rpcCalls: Array<{ name: string; args: unknown }> = [];
    const service = createAdminService({
      getAdminClient: () => fakeAdmin({ workspaceId: WORKSPACE_ID, rpcCalls }),
      credits: {} as never,
    });
    await service.grantCredits(USER_ID, 500, "活动赠送");
    expect(rpcCalls).toEqual([
      {
        name: "admin_adjust_credits",
        args: {
          p_workspace_id: WORKSPACE_ID,
          p_user_id: USER_ID,
          p_amount: 500,
          p_description: "活动赠送",
        },
      },
    ]);
  });

  it("grantCredits：无个人工作区时 fail loud（404）", async () => {
    const service = createAdminService({
      getAdminClient: () => fakeAdmin({ workspaceId: null }),
      credits: {} as never,
    });
    await expect(service.grantCredits(USER_ID, 10)).rejects.toBeInstanceOf(
      AdminServiceError,
    );
  });

  it("setRole：更新 profiles.role", async () => {
    const service = createAdminService({
      getAdminClient: () => fakeAdmin({ role: "user" }),
      credits: {} as never,
    });
    await expect(service.setRole(USER_ID, "admin")).resolves.toBeUndefined();
  });

  it("setPlan：委托 credits.updatePlan（套餐额度随后端一致）", async () => {
    const calls: Array<[string, string]> = [];
    const service = createAdminService({
      getAdminClient: () => fakeAdmin({ workspaceId: WORKSPACE_ID }),
      credits: {
        updatePlan: async (workspaceId: string, plan: string) => {
          calls.push([workspaceId, plan]);
        },
      } as never,
    });
    await service.setPlan(USER_ID, "ultra");
    expect(calls).toEqual([[WORKSPACE_ID, "ultra"]]);
  });
});
