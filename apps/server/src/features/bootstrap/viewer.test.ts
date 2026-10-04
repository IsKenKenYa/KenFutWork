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

/**
 * 记录型 persistence 假体：断言 SQL 与是否走了工作区作用域。
 * `rows` 为所有语句共用的返回集；需要「按调用次序返回不同结果」时用 `rowsSequence`
 * （第 n 项即第 n 条语句的结果，缺省空数组）。
 */
function createRecordingPersistence(
  options: { fail?: Error; rows?: SqlRow[]; rowsSequence?: SqlRow[][] } = {},
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
    return options.rowsSequence?.[calls.length - 1] ?? rows;
  };

  const read = {
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      return record(sql, params) as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      return (record(sql, params)[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      return record(sql, params).length;
    },
  };

  /** 作用域方法体（工作区/用户两种作用域共用，只记录绑定的 id）。 */
  const scopedMethods = (id: string) => ({
    async query<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      return record(sql, params, id) as T[];
    },
    async queryOne<T extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly unknown[],
    ) {
      return (record(sql, params, id)[0] as T | undefined) ?? null;
    },
    async execute(sql: string, params?: readonly unknown[]) {
      return record(sql, params, id).length;
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
    acquireSessionLock: async () => {
      throw new Error("此 viewer 夹具不提供执行宿主锁。");
    },
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
  it("bootstrap 在单事务内写 profile + 个人工作区 + owner 成员，不走工作区作用域", async () => {
    const { calls, persistence } = createRecordingPersistence({
      // 第 2 条（工作区 insert）返回新行 ⇒ 不复用分支
      rowsSequence: [[], [{ id: WORKSPACE_ID }], []],
    });
    await createViewerRepository(persistence).bootstrap({
      email: EMAIL,
      userMeta: { full_name: "Ada" },
      userId: USER_ID,
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.workspaceId === undefined)).toBe(true);

    const [profile, workspace, membership] = calls;
    expect(profile?.sql).toContain("insert into public.profiles");
    // 显示名回退链：meta 无 display_name → full_name
    expect(profile?.params).toEqual([USER_ID, EMAIL, "Ada", null]);

    expect(workspace?.sql).toContain("insert into public.workspaces");
    expect(workspace?.params).toEqual(["Ada Workspace", USER_ID]);

    expect(membership?.sql).toContain("insert into public.workspace_members");
    expect(membership?.params).toEqual([WORKSPACE_ID, USER_ID]);
  });

  it("bootstrap 幂等：个人工作区已存在（insert 冲突）时复用既有 id", async () => {
    const { calls, persistence } = createRecordingPersistence({
      // 第 2 条 insert 因唯一索引冲突返回空 ⇒ 第 3 条 select 取到既有行
      rowsSequence: [[], [], [{ id: WORKSPACE_ID }], []],
    });
    await createViewerRepository(persistence).bootstrap({
      email: EMAIL,
      userMeta: {},
      userId: USER_ID,
    });

    expect(calls).toHaveLength(4);
    expect(calls[1]?.sql).toContain("insert into public.workspaces");
    expect(calls[1]?.sql).toContain(
      "on conflict (owner_user_id) where type = 'personal'",
    );
    expect(calls[2]?.sql).toContain("select id");
    expect(calls[2]?.params).toEqual([USER_ID]);
    expect(calls[3]?.sql).toContain("insert into public.workspace_members");
    expect(calls[3]?.params).toEqual([WORKSPACE_ID, USER_ID]);
  });

  it("显示名解析沿用原 RPC 口径：meta 空串不回退邮箱，只有缺省才回退", async () => {
    const blank = createRecordingPersistence({
      rowsSequence: [[], [{ id: WORKSPACE_ID }], []],
    });
    await createViewerRepository(blank.persistence).bootstrap({
      email: EMAIL,
      userMeta: { display_name: "   " },
      userId: USER_ID,
    });
    expect(blank.calls[0]?.params?.[2]).toBeNull();
    expect(blank.calls[1]?.params?.[0]).toBe("Personal Workspace");

    const fromEmail = createRecordingPersistence({
      rowsSequence: [[], [{ id: WORKSPACE_ID }], []],
    });
    await createViewerRepository(fromEmail.persistence).bootstrap({
      email: "ada@example.com",
      userMeta: { avatar_url: "  https://x.test/a.png  " },
      userId: USER_ID,
    });
    expect(fromEmail.calls[0]?.params).toEqual([
      USER_ID,
      "ada@example.com",
      "ada",
      "https://x.test/a.png",
    ]);
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
