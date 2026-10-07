import { LocalInstanceError } from "../local-instance/service.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { SkillCatalogRepository } from "./repository.js";

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
}): InstanceSkillResourceReader {
  return {
    async read(instanceId, slug, resourcePath = "SKILL.md") {
      if ((await options.localInstance.getContext()).instanceId !== instanceId)
        throw new LocalInstanceError();
      const path = canonicalResourcePath(resourcePath);
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
