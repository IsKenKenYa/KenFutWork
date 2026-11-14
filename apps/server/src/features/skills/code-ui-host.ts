import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  codeUiSkillCopyRequestSchema,
  codeUiSkillDeleteRequestSchema,
  codeUiSkillRemoveFromCommonRequestSchema,
  codeUiSkillsRequestSchema,
  codeUiSkillToggleRequestSchema,
} from "@kenfutwork/shared";
import type { SkillsListResult } from "@zcode/shared";
import { z } from "zod";
import { resolveInsideRoot } from "../../utils/inside-root.js";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { PluginRegistryService } from "../plugins/plugin-registry-service.js";
import type { ProjectDetailRow } from "../projects/repository.js";
import type {
  ProjectSkillRepository,
  SkillCatalogRepository,
} from "./repository.js";
import { readSkillDocumentBody } from "./skill-document-body.js";
import { pluginSkillReference } from "./skill-resource-service.js";

function xmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 通用目录里的技能包文件名；技能正文即完整 SKILL.md。 */
const SKILL_FILE = "SKILL.md";

function commonConflict(message: string) {
  return new CodeUiHostRpcError("skill_common_conflict", message, 409);
}

function readTree(dir: string, prefix: string, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error("技能包内含符号链接或特殊文件。");
    }
    if (stat.isDirectory()) {
      readTree(absolute, relative, out);
    } else {
      out.set(relative, readFileSync(absolute, "utf8"));
    }
  }
}

/** 目录内容与技能包逐文件比对；多文件、少文件或内容不同都算冲突。 */
function packageMatches(
  dir: string,
  files: readonly { path: string; content: string }[],
): boolean {
  let tree: Map<string, string>;
  try {
    tree = new Map();
    readTree(dir, "", tree);
  } catch {
    return false;
  }
  if (tree.size !== files.length) return false;
  return files.every((file) => tree.get(file.path) === file.content);
}

/** Code 宿主技能 RPC：列表、启停、删除、项目作用域、通用目录导出与提示词上下文。 */
export function createCodeUiSkillsHost(deps: {
  localInstance: LocalInstanceService;
  repository: Pick<
    SkillCatalogRepository,
    | "listInstanceSkills"
    | "setEnabled"
    | "uninstall"
    | "findVisibleById"
    | "listFilesForVisibleSkill"
  >;
  plugins: Pick<PluginRegistryService, "readSkillPackages">;
  projectSkills: ProjectSkillRepository;
  projects: {
    findDirectoryProjects(
      instanceId: string,
      path: string,
    ): Promise<ProjectDetailRow[]>;
  };
  /** 通用技能目录；未配置时复制与移除都返回可读原因。 */
  commonSkillsRoot?: string;
}): Record<string, CodeUiHostRpcHandler> {
  const missing = () =>
    new CodeUiHostRpcError(
      "skill_not_installed",
      "技能安装状态已改变，请刷新列表。",
      404,
    );
  const resolveProject = async (
    instanceId: string,
    workspacePath: string | undefined,
  ): Promise<{ id: string; name: string } | null> => {
    const path = workspacePath?.trim();
    if (!path) return null;
    const rows = await deps.projects.findDirectoryProjects(instanceId, path);
    const row = rows[0];
    return row ? { id: row.id, name: row.name } : null;
  };
  const projectUnavailable = () =>
    new CodeUiHostRpcError(
      "skill_project_unavailable",
      "当前目录未关联项目，无法设置项目技能。",
      404,
    );
  const commonRoot = (): string => {
    const root = deps.commonSkillsRoot?.trim();
    if (!root) {
      throw new CodeUiHostRpcError(
        "skill_common_unavailable",
        "未配置通用技能目录。",
        501,
      );
    }
    return resolve(root);
  };
  const loadPackage = async (
    instanceId: string,
    skillId: string,
  ): Promise<{
    slug: string;
    files: { path: string; content: string }[];
  }> => {
    const row = await deps.repository.findVisibleById(instanceId, skillId);
    if (!row) {
      throw new CodeUiHostRpcError(
        "skill_not_found",
        "技能不存在或已删除，请刷新列表。",
        404,
      );
    }
    const slug = typeof row.slug === "string" ? row.slug : "";
    const content =
      typeof row.skill_content === "string" ? row.skill_content : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(slug) || !content) {
      throw new CodeUiHostRpcError(
        "skill_package_unreadable",
        "技能包缺少可用的目录名或正文。",
        500,
      );
    }
    const extra = (
      await deps.repository.listFilesForVisibleSkill(instanceId, skillId)
    )
      .map((file) => ({
        path: typeof file.file_path === "string" ? file.file_path : "",
        content: typeof file.content === "string" ? file.content : "",
      }))
      .filter((file) => file.path !== "" && file.path !== SKILL_FILE);
    return { slug, files: [{ path: SKILL_FILE, content }, ...extra] };
  };
  const targetDirectory = (slug: string): string => {
    const root = commonRoot();
    try {
      return resolveInsideRoot(root, slug);
    } catch {
      throw new CodeUiHostRpcError(
        "skill_slug_invalid",
        "技能目录名不可用于通用目录。",
        400,
      );
    }
  };

  return {
    "skills.list": {
      async call(actor, args): Promise<SkillsListResult> {
        const owner = await deps.localInstance.resolve(actor);
        codeUiSkillsRequestSchema.parse(args[0] ?? {});
        const rows = await deps.repository.listInstanceSkills(owner.instanceId);
        const plugins = await deps.plugins.readSkillPackages();
        return {
          skills: [
            ...rows.map((row) => ({
              id: row.skillId,
              ...(row.installationRevision
                ? { installationRevision: row.installationRevision }
                : {}),
              name: row.slug,
              description: row.description,
              body: readSkillDocumentBody(row.skillContent),
              path: "",
              scope: "user" as const,
              enabled: row.enabled,
              resourceRef: `kenfutwork-skill:${row.skillId}`,
              metadata: { slug: row.slug },
            })),
            ...plugins.flatMap((packageInfo) =>
              packageInfo.skills.map((skill) => ({
                id: pluginSkillReference(
                  packageInfo.pluginId,
                  skill.relativePath,
                ),
                name: skill.name,
                description: skill.description,
                body: readSkillDocumentBody(skill.content),
                path: "",
                resourceRef: pluginSkillReference(
                  packageInfo.pluginId,
                  skill.relativePath,
                ),
                scope: "plugin" as const,
                enabled: packageInfo.enabled,
                pluginId: packageInfo.pluginId,
                pluginName: packageInfo.pluginName,
                metadata: { slug: skill.name, version: packageInfo.version },
              })),
            ),
          ],
          capability: {
            userScopeAvailable: true,
            databaseRecords: true,
            workspaceScopeAvailable: true,
            externalImportAvailable: true,
          },
          diagnostics: [],
        };
      },
    },
    "skills.setEnabled": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillToggleRequestSchema.parse(args[0]);
        if (input.scope === "plugin") {
          throw new CodeUiHostRpcError(
            "skill_scope_readonly",
            "插件技能由插件管理，不能单独启停。",
            400,
          );
        }
        if (input.scope === "workspace") {
          const project = await resolveProject(
            owner.instanceId,
            input.workspacePath,
          );
          if (!project) throw projectUnavailable();
          const installed = (
            await deps.repository.listInstanceSkills(owner.instanceId)
          ).some((row) => row.skillId === input.skillId);
          if (!installed) throw missing();
          const changed = await deps.projectSkills.upsertProjectSkill({
            instanceId: owner.instanceId,
            projectId: project.id,
            skillId: input.skillId,
            enabled: input.enabled,
          });
          if (changed === 0) throw projectUnavailable();
          return null;
        }
        if (
          !(await deps.repository.setEnabled(
            owner.instanceId,
            input.skillId,
            input.enabled,
            input.installationRevision,
          ))
        )
          throw missing();
        return null;
      },
    },
    "skills.projectSettings": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillsRequestSchema.parse(args[0] ?? {});
        const project = await resolveProject(
          owner.instanceId,
          input.workspacePath,
        );
        if (!project) {
          return { projectId: null, projectName: null, skills: [] };
        }
        const installedIds = new Set(
          (await deps.repository.listInstanceSkills(owner.instanceId)).map(
            (row) => row.skillId,
          ),
        );
        const rows = (
          await deps.projectSkills.listProjectSkills(
            owner.instanceId,
            project.id,
          )
        ).filter((row) => installedIds.has(row.skillId));
        return {
          projectId: project.id,
          projectName: project.name,
          skills: rows,
        };
      },
    },
    "skills.deleteSkill": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillDeleteRequestSchema.parse(args[0]);
        // 原目录删除在DB包边界表示卸载；保留可见目录定义，不伪造物理文件操作。
        if (
          !(await deps.repository.uninstall(
            owner.instanceId,
            input.skillId,
            input.installationRevision,
          ))
        )
          throw missing();
        return null;
      },
    },
    "skills.buildPromptContext": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillsRequestSchema
          .extend({ prompt: z.string() })
          .parse(args[0]);
        const project = await resolveProject(
          owner.instanceId,
          input.workspacePath,
        );
        const rows = await deps.repository.listInstanceSkills(
          owner.instanceId,
          project?.id,
        );
        const activated = rows.filter((row) => {
          const slug = row.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return (
            row.enabled &&
            new RegExp(
              `(?<![\\p{L}\\p{N}_$-])\\$${slug}(?![\\p{L}\\p{N}_-])`,
              "u",
            ).test(input.prompt)
          );
        });
        const block = [
          "<available_skills>",
          ...activated.map(
            (row) =>
              `<activated_skill name="${xmlAttribute(row.slug)}" resource_ref="kenfutwork-skill:${xmlAttribute(row.skillId)}">\n${row.skillContent}\n</activated_skill>`,
          ),
          "</available_skills>",
        ].join("\n");
        return {
          prompt: activated.length
            ? `${input.prompt}\n\n${block}`
            : input.prompt,
          activatedSkillNames: activated.map((row) => row.slug),
        };
      },
    },
    "skills.copyToCommon": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillCopyRequestSchema.parse(args[0]);
        const { slug, files } = await loadPackage(
          owner.instanceId,
          input.skillId,
        );
        const target = targetDirectory(slug);
        const existing = existsSync(target) ? lstatSync(target) : null;
        if (existing) {
          if (!existing.isDirectory() || !packageMatches(target, files)) {
            throw commonConflict("通用目录已有同名技能，内容不同。");
          }
          return { newPath: target };
        }
        try {
          mkdirSync(target, { recursive: true });
          for (const file of files) {
            const absolute = resolveInsideRoot(target, file.path);
            mkdirSync(dirname(absolute), { recursive: true });
            writeFileSync(absolute, file.content, "utf8");
          }
        } catch (error) {
          throw new CodeUiHostRpcError(
            "skill_common_write_failed",
            `通用目录写入失败：${error instanceof Error ? error.message : String(error)}`,
            500,
          );
        }
        return { newPath: target };
      },
    },
    "skills.removeFromCommon": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillRemoveFromCommonRequestSchema.parse(args[0]);
        const { slug, files } = await loadPackage(
          owner.instanceId,
          input.skillId,
        );
        const target = targetDirectory(slug);
        if (!existsSync(target)) {
          throw new CodeUiHostRpcError(
            "skill_not_in_common",
            "通用目录里没有这个技能。",
            409,
          );
        }
        const stat = lstatSync(target);
        if (!stat.isDirectory() || !packageMatches(target, files)) {
          throw commonConflict("通用目录的同名技能内容不同，已拒绝移除。");
        }
        try {
          rmSync(target, { recursive: true, force: true });
        } catch (error) {
          throw new CodeUiHostRpcError(
            "skill_common_write_failed",
            `通用目录移除失败：${error instanceof Error ? error.message : String(error)}`,
            500,
          );
        }
        return null;
      },
    },
  };
}
