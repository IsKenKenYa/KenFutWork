import type {
  PersistenceService,
  SqlTransaction,
} from "../persistence/types.js";

export type PersonalWorkspaceRecord = {
  id: string;
  name: string;
  ownerUserId: string;
  /** 查询按 `type = 'personal'` 限定，故恒为 personal（契约类型要求窄化）。 */
  type: "personal";
};

export type ViewerProfileRecord = {
  avatarUrl: string | null;
  displayName: string;
  email: string;
  id: string;
};

/** 平台角色：`profiles.role` 受 CHECK 约束，只有 user / admin 两值。 */
export type PlatformRoleRecord = "user" | "admin";

export type MembershipRecord = {
  role: string;
  userId: string;
  workspaceId: string;
};

/**
 * viewer 聚合的数据访问（`workspaces`/`profiles`/`workspace_members`）。
 * 隔离口径：引导与个人工作区解析按 `owner_user_id` 限定（`workspaces` 是工作区
 * 注册表本身，无 `workspace_id` 列）；成员读取按工作区谓词限定。
 */
export interface ViewerRepository {
  /** 幂等引导：profile + 个人 workspace + owner membership（原子 RPC，身份经参数传入）。 */
  bootstrap(input: {
    email: string;
    userMeta: Record<string, unknown>;
    userId: string;
  }): Promise<void>;
  findMembership(
    workspaceId: string,
    userId: string,
  ): Promise<MembershipRecord | null>;
  findPersonalWorkspace(
    userId: string,
  ): Promise<PersonalWorkspaceRecord | null>;
  findProfile(userId: string): Promise<ViewerProfileRecord | null>;
  /** 平台角色（`profiles.role`，与工作区成员角色是两回事）。 */
  findPlatformRole(userId: string): Promise<PlatformRoleRecord | null>;
  /** 设置平台角色（管理后台专用；调用方须先过管理员门）。 */
  updatePlatformRole(userId: string, role: PlatformRoleRecord): Promise<number>;
  /** 仅能改自己的 profile：`user_id` 取自鉴权结果，不接受调用方传入他人 id。 */
  updateDisplayName(
    userId: string,
    displayName: string,
  ): Promise<ViewerProfileRecord | null>;
}

type WorkspaceRow = {
  id: string;
  name: string;
  owner_user_id: string;
  type: string;
};
type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
};
type MembershipRow = { workspace_id: string; user_id: string; role: string };

const WORKSPACE_COLUMNS = "id, name, owner_user_id, type";
const PROFILE_COLUMNS = "id, email, display_name, avatar_url";

export function createViewerRepository(
  persistence: PersistenceService,
): ViewerRepository {
  return {
    async bootstrap({ email, userMeta, userId }) {
      const displayName = resolveDisplayName(email, userMeta);
      const avatarUrl = resolveAvatarUrl(userMeta);

      // 三项同事务：任一失败不得留下「有 workspace 无成员」这类半成品引导态
      // （与 M1.3 起建项目改由应用层显式事务完成同一口径，原 RPC 已删）。
      await persistence.transaction(async (tx) => {
        await tx.execute(
          `insert into public.profiles as p (id, email, display_name, avatar_url)
           values ($1, $2, $3, $4)
           on conflict (id) do update
             set email = coalesce(excluded.email, p.email),
                 display_name = coalesce(p.display_name, excluded.display_name),
                 avatar_url = coalesce(p.avatar_url, excluded.avatar_url)`,
          [userId, email, displayName, avatarUrl],
        );

        const workspaceId = await ensurePersonalWorkspace(tx, {
          displayName,
          userId,
        });

        await tx.execute(
          `insert into public.workspace_members as wm (workspace_id, user_id, role)
           values ($1, $2, 'owner')
           on conflict (workspace_id, user_id) do update set role = 'owner'`,
          [workspaceId, userId],
        );
      });
    },

    async findMembership(workspaceId, userId) {
      const row = await persistence
        .forWorkspace(workspaceId)
        .queryOne<MembershipRow>(
          `select workspace_id, user_id, role
             from public.workspace_members
            where workspace_id = :workspace
              and user_id = $1`,
          [userId],
        );

      return row
        ? {
            role: row.role,
            userId: row.user_id,
            workspaceId: row.workspace_id,
          }
        : null;
    },

    async findPersonalWorkspace(userId) {
      const row = await persistence.queryOne<WorkspaceRow>(
        `select ${WORKSPACE_COLUMNS}
           from public.workspaces
          where owner_user_id = $1
            and type = 'personal'
          order by created_at
          limit 1`,
        [userId],
      );

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        name: row.name,
        ownerUserId: row.owner_user_id,
        type: "personal",
      };
    },

    async findProfile(userId) {
      const row = await persistence.queryOne<ProfileRow>(
        `select ${PROFILE_COLUMNS} from public.profiles where id = $1`,
        [userId],
      );
      return row ? mapProfile(row) : null;
    },

    async findPlatformRole(userId) {
      const row = await persistence.queryOne<{ role: string }>(
        "select role from public.profiles where id = $1",
        [userId],
      );
      if (!row) {
        return null;
      }
      return row.role === "admin" ? "admin" : "user";
    },

    async updatePlatformRole(userId, role) {
      // updated_at 由 profiles_set_updated_at 触发器维护。
      return persistence.execute(
        "update public.profiles set role = $1 where id = $2",
        [role, userId],
      );
    },

    async updateDisplayName(userId, displayName) {
      // updated_at 由 profiles_set_updated_at 触发器维护，不手工赋值。
      const row = await persistence.queryOne<ProfileRow>(
        `update public.profiles
            set display_name = $1
          where id = $2
        returning ${PROFILE_COLUMNS}`,
        [displayName, userId],
      );
      return row ? mapProfile(row) : null;
    },
  };
}

function mapProfile(row: ProfileRow): ViewerProfileRecord {
  return {
    avatarUrl: row.avatar_url ?? null,
    displayName: row.display_name ?? "Personal",
    email: row.email ?? "",
    id: row.id,
  };
}

/**
 * 取个人工作区 id，不存在则建。
 * `workspaces_personal_owner_user_id_key`（owner_user_id WHERE type='personal'）保证
 * 每人至多一个，故并发引导只会有一条插入成功，另一条走 select 分支拿同一 id。
 * 建表触发器负责初始化额度与技能，无需在此调用。
 */
async function ensurePersonalWorkspace(
  tx: SqlTransaction,
  input: { displayName: string | null; userId: string },
): Promise<string> {
  const inserted = await tx.queryOne<{ id: string }>(
    `insert into public.workspaces (type, name, owner_user_id)
     values ('personal', $1, $2)
     on conflict (owner_user_id) where type = 'personal' do nothing
     returning id`,
    [`${input.displayName ?? "Personal"} Workspace`, input.userId],
  );

  if (inserted) {
    return inserted.id;
  }

  const existing = await tx.queryOne<{ id: string }>(
    `select id
       from public.workspaces
      where owner_user_id = $1
        and type = 'personal'`,
    [input.userId],
  );

  if (!existing) {
    throw new Error("个人工作区 upsert 未返回 id 且查无既有行");
  }

  return existing.id;
}

const META_NAME_KEYS = ["display_name", "full_name", "name"] as const;

/**
 * 显示名解析（沿用原 `bootstrap_user_foundation` 口径）：meta 中首个字符串字段，
 * 缺省回退邮箱本地部分；btrim 后为空则 null（由上层 `mapProfile` 兜底 "Personal"）。
 */
function resolveDisplayName(
  email: string,
  userMeta: Record<string, unknown>,
): string | null {
  const candidate =
    META_NAME_KEYS.map((key) => userMeta[key]).find(
      (value) => typeof value === "string",
    ) ??
    email.split("@")[0] ??
    "";
  const trimmed = candidate.trim();
  return trimmed === "" ? null : trimmed;
}

function resolveAvatarUrl(userMeta: Record<string, unknown>): string | null {
  const raw =
    typeof userMeta.avatar_url === "string" ? userMeta.avatar_url.trim() : "";
  return raw === "" ? null : raw;
}
