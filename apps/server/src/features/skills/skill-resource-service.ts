import { LocalInstanceError } from "../local-instance/service.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { PluginRegistryService } from "../plugins/plugin-registry-service.js";
import type { SkillCatalogRepository } from "./repository.js";

export function pluginSkillReference(pluginId: string, relativePath: string) {
  return `kenfutwork-plugin-skill:${encodeURIComponent(pluginId)}/${encodeURIComponent(relativePath)}`;
}

export async function findPluginSkill(
  plugins: Pick<PluginRegistryService, "readSkillPackages">,
  reference: string,
  mode?: "code" | "design",
) {
  for (const packageInfo of await plugins.readSkillPackages(mode)) {
    if (!packageInfo.enabled) continue;
    const skill = packageInfo.skills.find(
      (entry) =>
        pluginSkillReference(packageInfo.pluginId, entry.relativePath) ===
        reference,
    );
    if (skill) return skill;
  }
  return undefined;
}

export interface InstanceSkillResource {
  name: string;
  resourceRef: string;
  resourcePath: string;
  content: string;
}
export interface InstanceSkillResourceReader {
  read(
    instanceId: string,
    slug: string,
    resourcePath?: string,
    mode?: "code" | "design",
  ): Promise<InstanceSkillResource | undefined>;
}
/** 安装包是只读DB资源；读取不签发本机路径、执行权限或NativeRead observation。 */
function canonicalResourcePath(path: string): string {
  const value = path.replaceAll("\\", "/");
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\0") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("技能资源路径必须是包内canonical相对路径。");
  return value;
}

export function createInstanceSkillResourceReader(options: {
  localInstance: LocalInstanceService;
  repository: Pick<
    SkillCatalogRepository,
    "listInstanceSkills" | "listSkillFiles"
  >;
  plugins?: Pick<PluginRegistryService, "readSkillPackages">;
}): InstanceSkillResourceReader {
  return {
    async read(instanceId, slug, resourcePath = "SKILL.md", mode) {
      if ((await options.localInstance.getContext()).instanceId !== instanceId)
        throw new LocalInstanceError();
      const path = canonicalResourcePath(resourcePath);
      if (slug.startsWith("kenfutwork-plugin-skill:")) {
        if (!options.plugins) throw new Error("插件技能读取未接入。");
        const skill = await findPluginSkill(options.plugins, slug, mode);
        if (!skill) return undefined;
        const content =
          path === "SKILL.md"
            ? skill.content
            : skill.files.find(
                (file) => canonicalResourcePath(file.path) === path,
              )?.content;
        if (content === undefined) return undefined;
        return { name: slug, resourceRef: slug, resourcePath: path, content };
      }
      const installed = (
        await options.repository.listInstanceSkills(instanceId)
      ).find((row) => row.slug === slug && row.enabled);
      if (!installed) return undefined;
      let content = installed.skillContent;
      if (path !== "SKILL.md") {
        const files = await options.repository.listSkillFiles(instanceId, [
          installed.skillId,
        ]);
        const file = files.find(
          (entry) =>
            entry.skillId === installed.skillId &&
            canonicalResourcePath(entry.path) === path,
        );
        if (!file) return undefined;
        content = file.content;
      }
      // 已卸载/停用的迟到读取不得返回包内容；DB安装态与资源相对路径都再次核对。
      const current = (
        await options.repository.listInstanceSkills(instanceId)
      ).find(
        (row) =>
          row.skillId === installed.skillId && row.slug === slug && row.enabled,
      );
      if (!current || canonicalResourcePath(path) !== path) return undefined;
      return {
        name: slug,
        resourceRef: `kenfutwork-skill:${installed.skillId}`,
        resourcePath: path,
        content: path === "SKILL.md" ? current.skillContent : content,
      };
    },
  };
}
