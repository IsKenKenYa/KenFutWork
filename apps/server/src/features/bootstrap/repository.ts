import type { PersistenceService, SqlRow } from "../persistence/types.js";

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
      await persistence.query<SqlRow>(
        "select public.bootstrap_viewer($1, $2, $3::jsonb) as workspace_id",
        [userId, email, JSON.stringify(userMeta)],
      );
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
