import { posix } from "node:path";
import type { PluginBundleManifest } from "@kenfutwork/shared";
import { parseSkillManifest } from "../skills/skill-import-service.js";
import type { BundleFiles } from "./bundle-manifest.js";

/** 从包文本发现组件；不导入插件入口，也不生成安装缓存。 */
export function describeBundleFiles(
  files: BundleFiles,
  manifest: PluginBundleManifest,
) {
  const skills: Array<{ name: string; description: string }> = [];
  const names = new Set<string>();
  for (const [file, content] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!file.startsWith("skills/") || posix.basename(file) !== "SKILL.md")
      continue;
    const skill = parseSkillManifest(content);
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    skills.push({ name: skill.name, description: skill.description });
  }
  return { skills, metadata: { version: manifest.version } };
}
