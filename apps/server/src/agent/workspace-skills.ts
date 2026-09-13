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
export interface WorkspaceSkillEntry {
  /** Skill slug (used as directory name in virtual path) */
  name: string;
  /** Human-readable description for the system prompt */
  description: string;
  /** Virtual path where the agent can read_file the full SKILL.md content */
  path: string;
  /** Raw SKILL.md content stored in the database */
  content: string;
  /** Associated files (scripts, references, assets) */
  files: SkillFileEntry[];
}

export type WorkspaceSkillsLoader = (
  canvasId: string,
) => Promise<WorkspaceSkillEntry[]>;

/**
 * 技能加载缝（agent 侧消费）：把「画布 → 工作区 → 已启用 skill + 附带文件」
 * 从 agent 内部装配收敛到数据访问层。
 *
 * 数据访问全部经 repository（工作区谓词）——技能表本身没有 workspace_id，
 * 靠 `workspace_skills` 这一层限定；不用裸 skill id 取数。
 */
export function createWorkspaceSkillsLoader(options: {
  canvases: CanvasRepository;
  skills: SkillCatalogRepository;
}): WorkspaceSkillsLoader {
  const { canvases, skills } = options;

  return async (canvasId) => {
    const workspaceId = await canvases
      .findWorkspaceIdByCanvas(canvasId)
      .catch(() => null);
    if (!workspaceId) return [];

    const installed = await skills
      .listWorkspaceSkills(workspaceId)
      .catch(() => []);

    // 只取启用项；无 SKILL.md 正文的条目跳过（旧的告警语义保留）
    const enabled = installed.filter((entry) => entry.enabled);

    const filesBySkillId = new Map<string, SkillFileEntry[]>();
    const files = await skills
      .listSkillFiles(
        workspaceId,
        enabled.map((entry) => entry.skillId),
      )
      .catch(() => []);

    for (const file of files) {
      const existing = filesBySkillId.get(file.skillId) ?? [];
      existing.push({ path: file.path, content: file.content });
      filesBySkillId.set(file.skillId, existing);
    }

    return enabled
      .map((entry) => {
        if (!entry.skillContent) {
          console.warn(
            `[workspace-skills] Skill "${entry.slug}" is enabled but has empty content — skipping`,
          );
          return null;
        }

        return {
          name: entry.slug,
          description: entry.description,
          path: `/workspace-skills/${entry.slug}/SKILL.md`,
          content: entry.skillContent,
          files: filesBySkillId.get(entry.skillId) ?? [],
        };
      })
      .filter((entry): entry is WorkspaceSkillEntry => entry !== null);
  };
}
