import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "../auth/types.js";
import { SqlError } from "../persistence/errors.js";
import type { PersistenceService, SqlRow } from "../persistence/types.js";
import { createViewerService } from "./ensure-user-foundation.js";
import { BootstrapError, ProfileUpdateError } from "./errors.js";
import { createViewerRepository, type ViewerRepository } from "./repository.js";

const USER_ID = "user-1";
const WORKSPACE_ID = "ws-1";
const EMAIL = "user@example.com";

const USER: AuthenticatedUser = {
  accessToken: "token",
  email: EMAIL,
  id: USER_ID,
  userMetadata: { full_name: "Ada" },
};

type RecordedCall = {
  params: readonly unknown[] | undefined;
  sql: string;
  workspaceId?: string;
};

/** 记录型 persistence 假体：断言 SQL 与是否走了工作区作用域。 */
function createRecordingPersistence(
  options: { fail?: Error; rows?: SqlRow[] } = {},
) {
  const calls: RecordedCall[] = [];
  const rows = options.rows ?? [];

  const record = (
    sql: string,
    params: readonly unknown[] | undefined,
    workspaceId?: string,
  ) => {
    calls.push({
      params,
      sql,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    if (options.fail) {
      throw options.fail;
    }
  };

  const read = {
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      record(sql, params);
      return rows as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      record(sql, params);
      return (rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      record(sql, params);
      return rows.length;
    },
  };

  /** 作用域方法体（工作区/用户两种作用域共用，只记录绑定的 id）。 */
  const scopedMethods = (id: string) => ({
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      record(sql, params, id);
      return rows as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      record(sql, params, id);
      return (rows[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      record(sql, params, id);
      return rows.length;
    },
  });

  const forWorkspace = (workspaceId: string) => ({
    workspaceId,
    ...scopedMethods(workspaceId),
  });
  const forUser = (userId: string) => ({
    userId,
    ...scopedMethods(userId),
  });

  const persistence: PersistenceService = {
    ...read,
    forUser,
    forWorkspace,
    transaction: (fn) => fn({ ...read, forUser, forWorkspace }),
    ping: async () => {},
    close: async () => {},
  };

  return { calls, persistence };
}

function createFakeRepository(
  overrides: Partial<ViewerRepository> = {},
): ViewerRepository {
  return {
    bootstrap: async () => {},
    findMembership: async () => ({
      role: "owner",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
    }),
    findPersonalWorkspace: async () => ({
      id: WORKSPACE_ID,
      name: "Personal Workspace",
      ownerUserId: USER_ID,
      type: "personal",
    }),
    findProfile: async () => ({
      avatarUrl: null,
      displayName: "Personal",
      email: EMAIL,
      id: USER_ID,
    }),
    findPlatformRole: async () => null,
    updatePlatformRole: async () => 0,
    updateDisplayName: async () => ({
      avatarUrl: null,
      displayName: "Ada",
      email: EMAIL,
      id: USER_ID,
    }),
    ...overrides,
  };
}

describe("viewer repository（workspaces/profiles/workspace_members）", () => {
  it("bootstrap 经参数传入身份调用原子 RPC，不走工作区作用域", async () => {
    const { calls, persistence } = createRecordingPersistence();
    await createViewerRepository(persistence).bootstrap({
      email: EMAIL,
      userMeta: { full_name: "Ada" },
      userId: USER_ID,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("public.bootstrap_viewer");
    expect(calls[0]?.params).toEqual([
      USER_ID,
      EMAIL,
      JSON.stringify({ full_name: "Ada" }),
    ]);
    expect(calls[0]?.workspaceId).toBeUndefined();
  });

  it("成员读取走工作区作用域（SQL 带 :workspace 谓词）", async () => {
    const { calls, persistence } = createRecordingPersistence();
    await createViewerRepository(persistence).findMembership(
      WORKSPACE_ID,
      USER_ID,
    );

    expect(calls[0]?.workspaceId).toBe(WORKSPACE_ID);
    expect(calls[0]?.sql).toContain(":workspace");
    expect(calls[0]?.params).toEqual([USER_ID]);
  });

  it("个人工作区按 owner_user_id + type=personal 限定并取最早创建", async () => {
    const { calls, persistence } = createRecordingPersistence();
    await createViewerRepository(persistence).findPersonalWorkspace(USER_ID);

    const sql = calls[0]?.sql ?? "";
    expect(calls[0]?.params).toEqual([USER_ID]);
    expect(sql).toContain("owner_user_id = $1");
    expect(sql).toContain("type = 'personal'");
    expect(sql).toContain("order by created_at");
    expect(sql).toContain("limit 1");
  });

  it("profile 空字段落回默认值", async () => {
    const { persistence } = createRecordingPersistence({
      rows: [
        { id: USER_ID, email: null, display_name: null, avatar_url: null },
      ],
    });

    await expect(
      createViewerRepository(persistence).findProfile(USER_ID),
    ).resolves.toEqual({
      avatarUrl: null,
      displayName: "Personal",
      email: "",
      id: USER_ID,
    });
  });

  it("更新显示名按 id 定位并返回更新后的行；无行时返回 null", async () => {
    const hit = createRecordingPersistence({
      rows: [
        {
          id: USER_ID,
          email: EMAIL,
          display_name: "Ada",
          avatar_url: null,
        },
      ],
    });
    await expect(
      createViewerRepository(hit.persistence).updateDisplayName(USER_ID, "Ada"),
    ).resolves.toEqual({
      avatarUrl: null,
      displayName: "Ada",
      email: EMAIL,
      id: USER_ID,
    });
    expect(hit.calls[0]?.sql).toContain("update public.profiles");
    expect(hit.calls[0]?.params).toEqual(["Ada", USER_ID]);

    const miss = createRecordingPersistence({ rows: [] });
    await expect(
      createViewerRepository(miss.persistence).updateDisplayName(
        USER_ID,
        "Ada",
      ),
    ).resolves.toBeNull();
  });
});

describe("viewer service", () => {
  it("引导成功返回解析后的 viewer 响应", async () => {
    const viewer = await createViewerService({
      repository: createFakeRepository(),
    }).ensureViewer(USER);

    expect(viewer).toEqual({
      membership: {
        role: "owner",
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
      },
      profile: {
        avatarUrl: null,
        displayName: "Personal",
        email: EMAIL,
        id: USER_ID,
      },
      workspace: {
        id: WORKSPACE_ID,
        name: "Personal Workspace",
        ownerUserId: USER_ID,
        type: "personal",
      },
    });
  });

  it("数据访问失败折叠为 BootstrapError（不泄露驱动错误）", async () => {
    const service = createViewerService({
      repository: createFakeRepository({
        bootstrap: async () => {
          throw new SqlError("permission denied", { code: "42501" });
        },
      }),
    });

    await expect(service.ensureViewer(USER)).rejects.toBeInstanceOf(
      BootstrapError,
    );
  });

  it("引导 RPC 失败后不再继续查询", async () => {
    let profileReads = 0;
    const service = createViewerService({
      repository: createFakeRepository({
        bootstrap: async () => {
          throw new SqlError("boom");
        },
        findProfile: async () => {
          profileReads += 1;
          return null;
        },
      }),
    });

    await expect(service.ensureViewer(USER)).rejects.toBeInstanceOf(
      BootstrapError,
    );
    expect(profileReads).toBe(0);
  });

  it("工作区/档案/成员任一缺失都抛 BootstrapError", async () => {
    const cases: Array<Partial<ViewerRepository>> = [
      { findPersonalWorkspace: async () => null },
      { findProfile: async () => null },
      { findMembership: async () => null },
    ];

    for (const overrides of cases) {
      const service = createViewerService({
        repository: createFakeRepository(overrides),
      });
      await expect(service.ensureViewer(USER)).rejects.toBeInstanceOf(
        BootstrapError,
      );
    }
  });

  it("resolveWorkspace 供其它聚合复用，缺失即 BootstrapError", async () => {
    const service = createViewerService({ repository: createFakeRepository() });
    await expect(service.resolveWorkspace(USER)).resolves.toEqual({
      id: WORKSPACE_ID,
      name: "Personal Workspace",
      ownerUserId: USER_ID,
      type: "personal",
    });

    const missing = createViewerService({
      repository: createFakeRepository({
        findPersonalWorkspace: async () => null,
      }),
    });
    await expect(missing.resolveWorkspace(USER)).rejects.toBeInstanceOf(
      BootstrapError,
    );
  });

  it("更新 profile 用鉴权结果里的 id，不接受调用方传入他人 id", async () => {
    const seen: string[] = [];
    const service = createViewerService({
      repository: createFakeRepository({
        updateDisplayName: async (userId, displayName) => {
          seen.push(userId, displayName);
          return {
            avatarUrl: null,
            displayName,
            email: EMAIL,
            id: userId,
          };
        },
      }),
    });

    const profile = await service.updateProfile(USER, "Ada");

    expect(seen).toEqual([USER_ID, "Ada"]);
    expect(profile.id).toBe(USER_ID);
  });

  it("更新 profile 无命中或数据访问失败都抛 ProfileUpdateError", async () => {
    const missing = createViewerService({
      repository: createFakeRepository({ updateDisplayName: async () => null }),
    });
    await expect(missing.updateProfile(USER, "Ada")).rejects.toBeInstanceOf(
      ProfileUpdateError,
    );

    const failing = createViewerService({
      repository: createFakeRepository({
        updateDisplayName: async () => {
          throw new SqlError("connection reset");
        },
      }),
    });
    await expect(failing.updateProfile(USER, "Ada")).rejects.toBeInstanceOf(
      ProfileUpdateError,
    );
  });
});
