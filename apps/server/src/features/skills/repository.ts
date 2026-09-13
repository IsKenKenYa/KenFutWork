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
export interface SkillCatalogRepository {
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
