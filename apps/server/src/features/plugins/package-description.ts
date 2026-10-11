import { posix } from "node:path";
import type { PluginBundleManifest } from "@kenfutwork/shared";
import { parseSkillManifest } from "../skills/skill-import-service.js";
import type { BundleFiles } from "./bundle-manifest.js";

/** 技能包是只读文本与包内相对资源；不签发本机目录或执行权限。 */
export function readBundleSkills(files: BundleFiles) {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(
      ([file]) =>
        file.startsWith("skills/") && posix.basename(file) === "SKILL.md",
    )
    .map(([file, content]) => {
      const manifest = parseSkillManifest(content);
      const root = `${posix.dirname(file)}/`;
      return {
        name: manifest.name,
        description: manifest.description,
        content,
        relativePath: file,
        files: Object.entries(files)
          .filter(([path]) => path.startsWith(root) && path !== file)
          .map(([path, content]) => ({
            path: path.slice(root.length),
            content,
          })),
      };
    });
}

/** 从包文本发现组件；不导入插件入口，也不生成安装缓存。 */
export function describeBundleFiles(
  files: BundleFiles,
  manifest: PluginBundleManifest,
) {
  const skills: Array<{ name: string; description: string }> = [];
  for (const skill of readBundleSkills(files)) {
    skills.push({ name: skill.name, description: skill.description });
  }
  return { skills, metadata: { version: manifest.version } };
}
