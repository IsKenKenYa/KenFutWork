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
