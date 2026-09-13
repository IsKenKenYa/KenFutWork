import type { SkillCatalogRepository } from "./repository.js";

/**
 * skill 目录服务（P5「skill 收敛为缝」）：
 * SKILL.md 发现从 agent 内部装配（workspace-skills）抽为可复用缝，
 * 由 skills 插件向 `ctx.tools` 贡献 `list_skills` / `use_skill` 工具。
 * 数据源与 SkillsMiddleware 同源（workspace_skills + skills.skill_content）。
 *
 * 入参是**工作区 id**而非用户对象：调用方（工具/路由）各自负责解析工作区，
 * 本服务只管按工作区取数——worker/agent 侧无需伪造用户身份。
 */

export interface SkillCatalogEntry {
  /** skill slug（deepagents 虚拟目录名） */
  name: string;
  description: string;
  enabled: boolean;
  /** 附加文件数（scripts/references/assets） */
  fileCount: number;
}

export interface SkillCatalogDetail {
  name: string;
  description: string;
  /** SKILL.md 全文（skills.skill_content） */
  content: string;
}

export interface SkillCatalogService {
  /** 工作区已安装 skill 清单（含停用，供管理视图；工具侧只展示启用项）。 */
  listSkills(workspaceId: string): Promise<SkillCatalogEntry[]>;
  /** 按 slug 取 SKILL.md 全文；未安装/停用即 404 语义。 */
  getSkill(
    workspaceId: string,
    slug: string,
  ): Promise<SkillCatalogDetail | undefined>;
}

export function createSkillCatalogService(options: {
  repository: SkillCatalogRepository;
}): SkillCatalogService {
  const { repository } = options;

  return {
    async listSkills(workspaceId) {
      const rows = await repository
        .listWorkspaceSkills(workspaceId)
        .catch(() => []);

      return rows.map((row) => ({
        name: row.slug,
        description: row.description,
        enabled: row.enabled,
        fileCount: 0,
      }));
    },

    async getSkill(workspaceId, slug) {
      const rows = await repository
        .listWorkspaceSkills(workspaceId)
        .catch(() => []);

      const row = rows.find((entry) => entry.slug === slug);

      if (!row?.enabled) {
        return undefined;
      }

      return {
        name: row.slug,
        description: row.description,
        content: row.skillContent,
      };
    },
  };
}
