import { LocalInstanceError } from "../local-instance/service.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { SkillCatalogRepository } from "./repository.js";

/**
 * skill 目录服务（P5「skill 收敛为缝」）：
 * SKILL.md 发现从 agent 内部装配（instance-skills）抽为可复用缝，
 * 由 skills 插件向 `ctx.tools` 贡献 `list_skills` / `use_skill` 工具。
 * 数据源与 SkillsMiddleware 同源（instance_skills + skills.skill_content）。
 *
 * 入参是**实例 id**而非用户对象：调用方（工具/路由）各自负责解析实例，
 * 本服务只管按实例取数——worker/agent 侧无需伪造用户身份。
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
  /** 实例已安装 skill 清单（含停用，供管理视图；工具侧只展示启用项）。 */
  listSkills(instanceId: string): Promise<SkillCatalogEntry[]>;
  /** 按 slug 取 SKILL.md 全文；未安装/停用即 404 语义。 */
  getSkill(
    instanceId: string,
    slug: string,
  ): Promise<SkillCatalogDetail | undefined>;
}

export function createSkillCatalogService(options: {
  localInstance: LocalInstanceService;
  repository: SkillCatalogRepository;
}): SkillCatalogService {
  const { repository } = options;

  return {
    async listSkills(instanceId) {
      if ((await options.localInstance.getContext()).instanceId !== instanceId)
        throw new LocalInstanceError();
      const rows = await repository.listInstanceSkills(instanceId);

      return rows.map((row) => ({
        name: row.slug,
        description: row.description,
        enabled: row.enabled,
        fileCount: 0,
      }));
    },

    async getSkill(instanceId, slug) {
      if ((await options.localInstance.getContext()).instanceId !== instanceId)
        throw new LocalInstanceError();
      const rows = await repository.listInstanceSkills(instanceId);

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
