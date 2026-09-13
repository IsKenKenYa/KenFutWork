import type { PersistenceService } from "../persistence/types.js";

export type WorkspaceSkillRecord = {
  enabled: boolean;
  skillId: string;
  slug: string;
  name: string;
  description: string;
  skillContent: string;
};

/**
 * skills 聚合的数据访问（`workspace_skills` JOIN `skills`）。
 * `workspace_skills` 带 `workspace_id`，故隔离谓词直接落在本表。
 */
export type SkillFileRecord = {
  skillId: string;
  path: string;
  content: string;
};

/** 已安装 skill 的行（保持路由既有的嵌套形状：`skills` 为 skill 明细）。 */
export type InstalledSkillRow = {
  skill_id: string;
  enabled: boolean;
  installed_at: string;
  skills: Record<string, unknown> | null;
};

export type UpsertInstallationInput = {
  enabled: boolean;
  installedBy: string;
  skillId: string;
  workspaceId: string;
};

export interface SkillCatalogRepository {
  /**
   * 指定 skill 的附带文件（scripts/references/assets）。
   * 仍带工作区谓词（经 workspace_skills JOIN）——skill_files 本身没有
   * workspace_id 列，不接受「裸 skill id」取数，避免越界读到别家文件。
   */
  listSkillFiles(
    workspaceId: string,
    skillIds: readonly string[],
  ): Promise<SkillFileRecord[]>;
  // ── 目录侧（`skills` / `skill_files`，均为全局表：读走「或」式可见性、写限本人） ──
  /** 可见目录（内置/社区 + 自建），按精选与名称排序。 */
  listVisible(userId: string): Promise<Record<string, unknown>[]>;
  /** 可见 skill 明细；不可见或不存在均为 null。 */
  findVisibleById(
    userId: string,
    skillId: string,
  ): Promise<Record<string, unknown> | null>;
  /**
   * 建 skill（`source='user'` 且 `created_by=本人` —— 与 RLS 写策略同义）。
   * 缺省字段沿用**列默认值**（`author='system'`/`version='1.0'`/`metadata='{}'`）：
   * 旧 PostgREST insert 不传的列即不出现，故此处用 `coalesce` 复刻同一语义，
   * 不能直接传 `null`（会写进 NULL 覆盖掉列默认）。
   */
  insertOwned(
    userId: string,
    input: {
      author?: string | null | undefined;
      category: string;
      description: string;
      iconName?: string | null | undefined;
      license?: string | null | undefined;
      metadata?: Record<string, unknown> | null | undefined;
      name: string;
      packageName?: string | null | undefined;
      skillContent: string;
      slug: string;
      source?: string | undefined;
      sourceUrl?: string | null | undefined;
      version?: string | null | undefined;
    },
  ): Promise<Record<string, unknown> | null>;
  /** 改 skill：仅本人创建的行（`created_by=本人` 写在语句里，不靠 RLS）。 */
  updateOwnedById(
    userId: string,
    skillId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  /** 删 skill：仅本人创建的行；返回受影响行数。 */
  deleteOwnedById(userId: string, skillId: string): Promise<number>;
  /** skill 的附带文件（经父链可见性）。 */
  listFilesForVisibleSkill(
    userId: string,
    skillId: string,
  ): Promise<Record<string, unknown>[]>;
  /** 写附带文件：仅当父 skill 属于本人（父子校验内联在一条语句里）。 */
  insertFilesForOwnedSkill(
    userId: string,
    skillId: string,
    rows: readonly {
      content: string;
      filePath: string;
      mimeType?: string | undefined;
    }[],
  ): Promise<number>;
  /** 工作区已安装 skill（含停用；工具侧自行过滤启用项）。 */
  listWorkspaceSkills(workspaceId: string): Promise<WorkspaceSkillRecord[]>;
  /** 已安装列表（含 skill 明细，供管理视图；嵌套形状与旧 PostgREST 查询一致）。 */
  listInstalled(workspaceId: string): Promise<InstalledSkillRow[]>;
  /**
   * 该用户**可见**的 skill（`source in ('system','community')` 或自己创建的）。
   * 这是 RLS 读策略的等价物：不能简化成纯 `created_by`，否则内置目录会消失。
   */
  findVisibleSkill(
    userId: string,
    skillId: string,
  ): Promise<{ id: string } | null>;
  /** 安装/启停：按 (workspace_id, skill_id) 冲突即更新。 */
  upsertInstallation(input: UpsertInstallationInput): Promise<void>;
  /** 卸载；返回受影响行数（0 = 未安装）。 */
  uninstall(workspaceId: string, skillId: string): Promise<number>;
}

type JoinedSkillRow = {
  enabled: boolean;
  id: string;
  slug: string;
  name: string;
  description: string;
  skill_content: string;
};

export function createSkillCatalogRepository(
  persistence: PersistenceService,
): SkillCatalogRepository {
  return {
    async listSkillFiles(workspaceId, skillIds) {
      if (skillIds.length === 0) {
        return [];
      }

      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<{ skill_id: string; file_path: string; content: string }>(
          `select sf.skill_id, sf.file_path, sf.content
             from public.skill_files sf
             join public.workspace_skills ws on ws.skill_id = sf.skill_id
            where ws.workspace_id = :workspace
              and sf.skill_id = any($1::uuid[])`,
          [skillIds],
        );

      return rows.map((row) => ({
        skillId: row.skill_id,
        path: row.file_path,
        content: row.content,
      }));
    },

    async listInstalled(workspaceId) {
      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<Record<string, unknown>>(
          `select ws.skill_id, ws.enabled, ws.installed_at, s.*
             from public.workspace_skills ws
             join public.skills s on s.id = ws.skill_id
            where ws.workspace_id = :workspace
            order by ws.installed_at desc`,
        );

      return rows.map((row) => {
        const { skill_id, enabled, installed_at, ...skill } = row;
        return {
          skill_id: skill_id as string,
          enabled: enabled as boolean,
          installed_at: installed_at as string,
          // 没有对应 skill 行时（内连接下不会发生）保持 null，与旧形状一致
          skills: Object.keys(skill).length > 0 ? skill : null,
        };
      });
    },

    async findVisibleSkill(userId, skillId) {
      const row = await persistence.forUser(userId).queryOne<{ id: string }>(
        `select id
           from public.skills
          where id = $1
            and (source in ('system', 'community') or created_by = :user)`,
        [skillId],
      );
      return row ?? null;
    },

    async upsertInstallation(input) {
      await persistence.forWorkspace(input.workspaceId).query(
        `insert into public.workspace_skills
                (workspace_id, skill_id, enabled, installed_by)
         values (:workspace, $1, $2, $3)
         on conflict (workspace_id, skill_id)
         do update set enabled = excluded.enabled`,
        [input.skillId, input.enabled, input.installedBy],
      );
    },

    async uninstall(workspaceId, skillId) {
      return persistence.forWorkspace(workspaceId).execute(
        `delete from public.workspace_skills
          where workspace_id = :workspace
            and skill_id = $1`,
        [skillId],
      );
    },

    async listVisible(userId) {
      return persistence.forUser(userId).query<Record<string, unknown>>(
        `select *
           from public.skills
          where source in ('system', 'community') or created_by = :user
          order by is_featured desc, name asc`,
      );
    },

    async findVisibleById(userId, skillId) {
      return persistence.forUser(userId).queryOne<Record<string, unknown>>(
        `select *
           from public.skills
          where id = $1
            and (source in ('system', 'community') or created_by = :user)`,
        [skillId],
      );
    },

    async insertOwned(userId, input) {
      return persistence.forUser(userId).queryOne<Record<string, unknown>>(
        `insert into public.skills
                (name, slug, description, category, skill_content, icon_name,
                 source, created_by, author, version, license, metadata,
                 source_url, package_name)
         values ($1, $2, $3, $4, $5, $6, $7, :user,
                 coalesce($8, 'system'), coalesce($9, '1.0'), $10,
                 coalesce($11::jsonb, '{}'::jsonb), $12, $13)
         returning *`,
        [
          input.name,
          input.slug,
          input.description,
          input.category,
          input.skillContent,
          input.iconName ?? null,
          input.source ?? "user",
          input.author ?? null,
          input.version ?? null,
          input.license ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.sourceUrl ?? null,
          input.packageName ?? null,
        ],
      );
    },

    async updateOwnedById(userId, skillId, patch) {
      const assignments: string[] = [];
      const values: unknown[] = [skillId];

      for (const [column, value] of Object.entries(patch)) {
        if (value === undefined) {
          continue;
        }
        values.push(column === "metadata" ? JSON.stringify(value) : value);
        assignments.push(
          `${column} = $${values.length}${column === "metadata" ? "::jsonb" : ""}`,
        );
      }

      if (assignments.length === 0) {
        return null;
      }

      return persistence.forUser(userId).queryOne<Record<string, unknown>>(
        `update public.skills
            set ${assignments.join(", ")}
          where id = $1
            and created_by = :user
        returning *`,
        values,
      );
    },

    async deleteOwnedById(userId, skillId) {
      return persistence.forUser(userId).execute(
        `delete from public.skills
          where id = $1
            and created_by = :user`,
        [skillId],
      );
    },

    async listFilesForVisibleSkill(userId, skillId) {
      return persistence.forUser(userId).query<Record<string, unknown>>(
        `select sf.*
           from public.skill_files sf
           join public.skills s on s.id = sf.skill_id
          where sf.skill_id = $1
            and (s.source in ('system', 'community') or s.created_by = :user)
          order by sf.file_path asc`,
        [skillId],
      );
    },

    async insertFilesForOwnedSkill(userId, skillId, rows) {
      if (rows.length === 0) {
        return 0;
      }

      const values: unknown[] = [skillId];
      const tuples = rows.map((row) => {
        values.push(row.filePath, row.content, row.mimeType ?? "text/plain");
        const end = values.length;
        return `($1, $${end - 2}, $${end - 1}, $${end})`;
      });

      return persistence.forUser(userId).execute(
        `insert into public.skill_files (skill_id, file_path, content, mime_type)
         select v.*
           from (values ${tuples.join(", ")})
                  as v(skill_id, file_path, content, mime_type)
          where exists (
            select 1 from public.skills s
             where s.id = $1 and s.created_by = :user
          )`,
        values,
      );
    },

    async listWorkspaceSkills(workspaceId) {
      const rows = await persistence
        .forWorkspace(workspaceId)
        .query<JoinedSkillRow>(
          `select ws.enabled, s.id, s.slug, s.name, s.description, s.skill_content
             from public.workspace_skills ws
             join public.skills s on s.id = ws.skill_id
            where ws.workspace_id = :workspace`,
        );

      return rows.map((row) => ({
        enabled: row.enabled,
        skillId: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        skillContent: row.skill_content,
      }));
    },
  };
}
