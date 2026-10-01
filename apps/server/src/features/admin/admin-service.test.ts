import { describe, expect, it } from "vitest";

import type { ViewerRepository } from "../bootstrap/repository.js";
import {
  createPersistenceFromRunner,
  type PostgresQueryRunner,
} from "../persistence/providers/postgres.js";
import { AdminServiceError, createAdminService } from "./admin-service.js";
import { type AdminRepository, createAdminRepository } from "./repository.js";

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const WORKSPACE_ID = "33333333-3333-3333-3333-333333333333";

const adminUser = {
  accessToken: "token",
  email: "admin@example.com",
  id: ADMIN_ID,
  userMetadata: {},
};

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

/** 驱动形状的原始行：bigint / numeric 列为字符串。 */
const RAW_OVERVIEW_ROW = {
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

const OVERVIEW_ROW = {
  ...RAW_OVERVIEW_ROW,
  total_tokens: 1500,
  cost_usd: 0.25,
};

describe("admin repository（平台级系统取数）", () => {
  it("平台总览调库函数并把 bigint/numeric 字符串归一为 number", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [RAW_OVERVIEW_ROW],
    }));

    const rows = await createAdminRepository(
      createPersistenceFromRunner(runner),
    ).fetchUsersOverview();

    expect(rows[0]).toEqual(OVERVIEW_ROW);
    expect(typeof rows[0]?.total_tokens).toBe("number");
    expect(typeof rows[0]?.cost_usd).toBe("number");
    expect(calls[0]?.text).toContain("public.admin_users_overview()");
    // 平台级取数：不做工作区限定（隔离边界是 HTTP 层的管理员门）
    expect(calls[0]?.text).not.toContain("workspace_id =");
  });

  it("额度调剂把身份作为显式参数传入库函数", async () => {
    const { calls, runner } = createRunner(() => ({
      rowCount: 1,
      rows: [{ tx_id: "tx-1" }],
    }));

    await expect(
      createAdminRepository(createPersistenceFromRunner(runner)).adjustCredits({
        amount: 500,
        description: "活动赠送",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      }),
    ).resolves.toBe("tx-1");

    expect(calls[0]?.text).toContain(
      "select public.admin_adjust_credits($1, $2, $3, $4) as tx_id",
    );
    expect(calls[0]?.values).toEqual([WORKSPACE_ID, USER_ID, 500, "活动赠送"]);
  });
});

function createFakeRepository(
  overrides: Partial<AdminRepository> = {},
): AdminRepository {
  return {
    adjustCredits: async () => "tx-1",
    fetchUsersOverview: async () => [],
    ...overrides,
  };
}

function createFakeWorkspaces(
  overrides: Partial<ViewerRepository> = {},
): ViewerRepository {
  return {
    bootstrap: async () => {},
    findMembership: async () => null,
    findPersonalWorkspace: async () => ({
      id: WORKSPACE_ID,
      name: "Personal Workspace",
      ownerUserId: USER_ID,
      type: "personal",
    }),
    findPlatformRole: async () => "user",
    findProfile: async () => null,
    updateDisplayName: async () => null,
    updatePlatformRole: async () => 1,
    ...overrides,
  };
}

function buildService(
  options: {
    repository?: Partial<AdminRepository>;
    workspaces?: Partial<ViewerRepository>;
    credits?: unknown;
    authDriver?: string;
  } = {},
) {
  return createAdminService({
    credits: (options.credits ?? {}) as never,
    repository: createFakeRepository(options.repository),
    workspaces: createFakeWorkspaces(options.workspaces),
    ...(options.authDriver !== undefined
      ? { authDriver: options.authDriver }
      : {}),
  });
}

describe("本机主人即管理员（local-trust 形态）", () => {
  it("local-trust 驱动下 isAdmin 恒 true：认证层保证唯一用户=本机主人，无需 DB 角色", async () => {
    await expect(
      buildService({ authDriver: "local-trust" }).isAdmin(USER_ID),
    ).resolves.toBe(true);
  });

  it("local-trust 下 requireAdmin 放行（插件安装等变更门不再锁主人）", async () => {
    await expect(
      buildService({ authDriver: "local-trust" }).requireAdmin({
        id: USER_ID,
        accessToken: "",
        email: "",
        userMetadata: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("managed（缺省）与未知驱动行为不变：仍走 DB role 判定", async () => {
    await expect(buildService().isAdmin(USER_ID)).resolves.toBe(false);
    await expect(
      buildService({ authDriver: "managed" }).isAdmin(USER_ID),
    ).resolves.toBe(false);
  });
});

describe("admin 服务（平台管理后台）", () => {
  it("isAdmin：只有 role='admin' 才是管理员；查不到即 false", async () => {
    await expect(
      buildService({
        workspaces: { findPlatformRole: async () => "admin" },
      }).isAdmin(ADMIN_ID),
    ).resolves.toBe(true);
    await expect(buildService().isAdmin(USER_ID)).resolves.toBe(false);
    await expect(
      buildService({
        workspaces: { findPlatformRole: async () => null },
      }).isAdmin(USER_ID),
    ).resolves.toBe(false);
  });

  it("requireAdmin：非管理员抛 403（前端隐藏不是安全边界）", async () => {
    const service = buildService();
    await expect(service.requireAdmin(adminUser)).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
  });

  it("总览读取失败按 admin_query_failed 报错（不泄露驱动细节）", async () => {
    const service = buildService({
      repository: {
        fetchUsersOverview: async () => {
          throw new Error("permission denied for function");
        },
      },
    });

    const error = await service.listUsers().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminServiceError);
    expect(error).toMatchObject({ code: "admin_query_failed" });
    expect((error as Error).message).not.toContain("permission denied");
  });

  it("listUsers：汇总行映射为契约形状", async () => {
    const service = buildService({
      repository: { fetchUsersOverview: async () => [OVERVIEW_ROW] },
    });

    await expect(service.listUsers()).resolves.toEqual([
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
    const service = buildService({
      repository: {
        fetchUsersOverview: async () => [
          OVERVIEW_ROW,
          {
            ...OVERVIEW_ROW,
            user_id: ADMIN_ID,
            email: "a@x.com",
            total_tokens: 0,
            cost_usd: 0,
          },
        ],
      },
    });

    const usage = await service.platformUsage();
    expect(usage.totals.totalTokens).toBe(1500);
    expect(usage.totals.costUsd).toBeCloseTo(0.25);
    expect(usage.byUser).toHaveLength(1);
    expect(usage.byUser[0]?.email).toBe("u@example.com");
  });

  it("grantCredits：解析目标用户工作区后带显式身份调剂额度", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = buildService({
      repository: {
        adjustCredits: async (input) => {
          calls.push(input);
          return "tx-1";
        },
      },
    });

    await service.grantCredits(USER_ID, 500, "活动赠送");
    expect(calls).toEqual([
      {
        amount: 500,
        description: "活动赠送",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      },
    ]);
  });

  it("grantCredits：描述缺省用 admin adjustment；无个人工作区即 404", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const withDefault = buildService({
      repository: {
        adjustCredits: async (input) => {
          calls.push(input);
          return "tx-1";
        },
      },
    });
    await withDefault.grantCredits(USER_ID, 10);
    expect(calls[0]).toMatchObject({ description: "admin adjustment" });

    const missing = buildService({
      workspaces: { findPersonalWorkspace: async () => null },
    });
    await expect(missing.grantCredits(USER_ID, 10)).rejects.toMatchObject({
      code: "user_not_found",
      statusCode: 404,
    });
  });

  it("setRole：写 profiles.role（经 workspaces 域数据访问）", async () => {
    const written: Array<[string, string]> = [];
    const service = buildService({
      workspaces: {
        updatePlatformRole: async (userId, role) => {
          written.push([userId, role]);
          return 1;
        },
      },
    });

    await expect(service.setRole(USER_ID, "admin")).resolves.toBeUndefined();
    expect(written).toEqual([[USER_ID, "admin"]]);
  });

  it("setPlan：委托 credits.updatePlan（套餐额度随后端一致）", async () => {
    const calls: Array<[string, string]> = [];
    const service = buildService({
      credits: {
        updatePlan: async (workspaceId: string, plan: string) => {
          calls.push([workspaceId, plan]);
        },
      },
    });

    await service.setPlan(USER_ID, "ultra");
    expect(calls).toEqual([[WORKSPACE_ID, "ultra"]]);
  });
});
