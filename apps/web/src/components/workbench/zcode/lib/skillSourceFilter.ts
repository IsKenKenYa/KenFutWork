/**
 * zcode 照搬：`@/lib/skillSourceFilter.ts`（references/zcode/packages/ui/src/lib/skillSourceFilter.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */
import type { ZCodeProvider } from "@zui/lib/zcode-shared";

type SkillSourceType = "glm" | "unknown";

function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.zcode/skills/")) {
    return "glm";
  }
  if (normalized.includes("/.zcode/cli/plugins/cache/")) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

function isZcodeSkill(skill: {
  id?: string;
  path: string;
  scope?: string;
}): boolean {
  return (
    // plugin skill 的真实路径在 CLI plugin cache 下，不在 `.zcode/skills`。
    // 服务层已用 scope 标记来源，前端过滤时要放行，否则 `/` 和 `$` 面板会漏掉插件技能。
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill.path) === "glm"
  );
}

export function filterSkillsForProvider<
  T extends { path: string; id?: string; scope?: string },
>(skills: T[], _legacyProvider: ZCodeProvider): T[] {
  return skills.filter(isZcodeSkill);
}
