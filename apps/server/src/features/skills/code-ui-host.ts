import {
  codeUiSkillDeleteRequestSchema,
  codeUiSkillsRequestSchema,
  codeUiSkillToggleRequestSchema,
} from "@kenfutwork/shared";
import type { SkillsListResult } from "@zcode/shared";
import { z } from "zod";
import {
  CodeUiHostRpcError,
  type CodeUiHostRpcHandler,
} from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { SkillCatalogRepository } from "./repository.js";

function xmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 原设置、REST、运行工具共读同一技能库存；包资源不是本机目录。 */
export function createCodeUiSkillsHost(deps: {
  localInstance: LocalInstanceService;
  repository: SkillCatalogRepository;
}): Record<string, CodeUiHostRpcHandler> {
  const missing = () =>
    new CodeUiHostRpcError(
      "skill_not_installed",
      "技能安装状态已改变，请刷新列表。",
      404,
    );
  const unavailable = () =>
    new CodeUiHostRpcError(
      "skill_capability_unavailable",
      "技能目录复制未接入。",
      501,
    );
  return {
    "skills.list": {
      async call(actor, args): Promise<SkillsListResult> {
        const owner = await deps.localInstance.resolve(actor);
        codeUiSkillsRequestSchema.parse(args[0] ?? {});
        const rows = await deps.repository.listInstanceSkills(owner.instanceId);
        return {
          skills: rows.map((row) => ({
            id: row.skillId,
            ...(row.installationRevision
              ? { installationRevision: row.installationRevision }
              : {}),
            name: row.slug,
            description: row.description,
            body: row.skillContent,
            path: "",
            scope: "user",
            enabled: row.enabled,
            resourceRef: `kenfutwork-skill:${row.skillId}`,
            metadata: { slug: row.slug },
          })),
          capability: {
            userScopeAvailable: true,
            databaseRecords: true,
            workspaceScopeAvailable: false,
            externalImportAvailable: false,
          },
          diagnostics: [],
        };
      },
    },
    "skills.setEnabled": {
      async call(actor, args) {
        const owner = await deps.localInstance.resolve(actor);
        const input = codeUiSkillToggleRequestSchema.parse(args[0]);
        if (input.scope && input.scope !== "user")
          throw new CodeUiHostRpcError(
            "skill_scope_unavailable",
            "项目和插件技能设置未接入。",
            501,
          );
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
        const rows = await deps.repository.listInstanceSkills(owner.instanceId);
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
      async call() {
        throw unavailable();
      },
    },
    "skills.removeFromCommon": {
      async call() {
        throw unavailable();
      },
    },
  };
}
