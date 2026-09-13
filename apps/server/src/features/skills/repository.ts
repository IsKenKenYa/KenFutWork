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
