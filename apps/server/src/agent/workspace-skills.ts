import type { CanvasRepository } from "../features/canvas/repository.js";
import type { SkillCatalogRepository } from "../features/skills/repository.js";

/**
 * A file bundled with a skill (scripts/, references/, assets/).
 */
export interface SkillFileEntry {
  /** Relative path, e.g. "scripts/analyze.py" */
  path: string;
  /** Raw file content */
  content: string;
}

/**
 * Metadata for a workspace skill loaded from the database.
 * Compatible with the deepagents SkillsMiddleware SkillMetadata shape.
 */
export interface InstanceSkillEntry {
  /** Skill slug (used as directory name in virtual path) */
  name: string;
  /** Human-readable description for the system prompt */
  description: string;
  /** Design Store路径或Code只读DB资源标识，提示段选择对应读取入口。 */
  path: string;
  /** Raw SKILL.md content stored in the database */
  content: string;
  /** Associated files (scripts, references, assets) */
  files: SkillFileEntry[];
}

export type InstanceSkillsLoader = (
  instanceId: string,
  canvasId: string,
) => Promise<InstanceSkillEntry[]>;

export type InstanceSkillsByInstanceLoader = (
  instanceId: string,
) => Promise<InstanceSkillEntry[]>;

/** Code用可信工作区身份读取安装包，不经Canvas JOIN，不签发物理FS路径。 */
export function createInstanceSkillsByInstanceLoader(options: {
  skills: Pick<SkillCatalogRepository, "listInstanceSkills" | "listSkillFiles">;
}): InstanceSkillsByInstanceLoader {
  return async (instanceId) => {
    const installed = await options.skills
      .listInstanceSkills(instanceId)
      .catch(() => []);
    const enabled = installed.filter((entry) => entry.enabled);
    const files = await options.skills
      .listSkillFiles(
        instanceId,
        enabled.map((entry) => entry.skillId),
      )
      .catch(() => []);
    const filesBySkillId = new Map<string, SkillFileEntry[]>();
    for (const file of files) {
      const packageFiles = filesBySkillId.get(file.skillId) ?? [];
      packageFiles.push({ path: file.path, content: file.content });
      filesBySkillId.set(file.skillId, packageFiles);
    }
    return enabled
      .filter((entry) => {
        if (entry.skillContent) return true;
        console.warn(
          `[workspace-skills] ${entry.slug} 正文为空，跳过提示注入。`,
        );
        return false;
      })
      .map((entry) => ({
        name: entry.slug,
        description: entry.description,
        path: `kenfutwork-skill:${entry.skillId}`,
        content: entry.skillContent,
        files: filesBySkillId.get(entry.skillId) ?? [],
      }));
  };
}

/**
 * 技能加载缝（agent 侧消费）：把「画布 → 工作区 → 已启用 skill + 附带文件」
 * 从 agent 内部装配收敛到数据访问层。
 *
 * 数据访问全部经 repository（工作区谓词）——技能表本身没有 instance_id，
 * 靠 `workspace_skills` 这一层限定；不用裸 skill id 取数。
 */
export function createInstanceSkillsLoader(options: {
  canvases: CanvasRepository;
  skills: SkillCatalogRepository;
}): InstanceSkillsLoader {
  const { canvases, skills } = options;
  const loadWorkspace = createInstanceSkillsByInstanceLoader({ skills });

  return async (instanceId, canvasId) => {
    const canvas = await canvases
      .findById(instanceId, canvasId)
      .catch(() => null);
    if (!canvas) return [];
    return (await loadWorkspace(instanceId)).map((entry) => ({
      ...entry,
      path: `/workspace-skills/${entry.name}/SKILL.md`,
    }));
  };
}
