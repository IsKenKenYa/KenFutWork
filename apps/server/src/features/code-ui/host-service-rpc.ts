import type { CodeUiViewerScope } from "@kenfutwork/shared";
import { codeUiViewerScopeSchema } from "@kenfutwork/shared";
import type { SkillSummary, SkillsListResult } from "@zcode/shared";
import { z } from "zod";
import type { LocalActor } from "../local-instance/types.js";
import type {
  InstanceSkillSettingsRepository,
  SkillCatalogRepository,
} from "../skills/repository.js";

export interface CodeUiHostTargetRequest {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  viewerScope?: CodeUiViewerScope | undefined;
}
export interface CodeUiHostTarget {
  instanceId: string;
  projectId: string;
  rootDirectory: string;
  viewerScope: CodeUiViewerScope;
}
export interface CodeUiHostConnection {
  connectionId: string;
  instanceId: string;
}
export interface CodeUiHostServicesRpc {
  call(
    actor: LocalActor,
    service: string,
    method: string,
    args: unknown[],
    connection: CodeUiHostConnection,
  ): Promise<{ result: unknown } | null>;
}

const skillParams = z.object({
  workspacePath: z.string().min(1),
  workspaceIdentity: z.string().optional(),
  viewerScope: codeUiViewerScopeSchema.optional(),
  provider: z.literal("zcode").optional(),
});
const toggleParams = skillParams.extend({
  skillId: z.uuid(),
  enabled: z.boolean(),
  scope: z.enum(["workspace", "user", "plugin"]).optional(),
});
type InstanceSkillSummary = SkillSummary & { resourceRef: string };
function xmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function createCodeUiHostServicesRpc(deps: {
  resolveTarget(
    actor: LocalActor,
    request: CodeUiHostTargetRequest,
  ): Promise<CodeUiHostTarget>;
  skills: Pick<SkillCatalogRepository, "listInstanceSkills">;
  skillSettings: InstanceSkillSettingsRepository;
}): CodeUiHostServicesRpc {
  const target = async (
    actor: LocalActor,
    value: unknown,
    connection: CodeUiHostConnection,
  ) => {
    if (!connection.connectionId || connection.instanceId !== actor.instanceId)
      throw new Error("Skills连接身份不属于当前用户。");
    const request = skillParams.parse(value);
    const resolved = await deps.resolveTarget(actor, request);
    if (resolved.instanceId !== connection.instanceId)
      throw new Error("Skills目标工作区与可信连接身份不匹配。");
    return resolved;
  };
  return {
    async call(actor, service, method, args, connection) {
      if (service !== "skills") return null;
      const supported = [
        "list",
        "setEnabled",
        "buildPromptContext",
        "copyToCommon",
        "removeFromCommon",
        "deleteSkill",
      ];
      if (!supported.includes(method)) return null;
      const scope = await target(actor, args[0], connection);
      if (["copyToCommon", "removeFromCommon", "deleteSkill"].includes(method))
        throw new Error(
          "此技能是工作区安装包资源，不是本机技能目录；不能假作本地路径复制或删除。",
        );
      if (method === "setEnabled") {
        const input = toggleParams.parse(args[0]);
        if (input.scope && input.scope !== "workspace")
          throw new Error("该技能设置只管理当前工作区的安装态。");
        if (
          !(await deps.skillSettings.setEnabled(
            scope.instanceId,
            input.skillId,
            input.enabled,
          ))
        )
          throw new Error("技能未安装、已卸载或不属于当前工作区。");
        return { result: undefined };
      }
      const rows = await deps.skills.listInstanceSkills(scope.instanceId);
      if (method === "buildPromptContext") {
        const { prompt } = skillParams
          .extend({ prompt: z.string() })
          .parse(args[0]);
        const activated = rows.filter((row) => {
          const slug = row.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return (
            row.enabled &&
            new RegExp(
              `(?<![\\p{L}\\p{N}_$-])\\$${slug}(?![\\p{L}\\p{N}_-])`,
              "u",
            ).test(prompt)
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
          result: {
            prompt: activated.length ? `${prompt}\n\n${block}` : prompt,
            activatedSkillNames: activated.map((row) => row.slug),
          },
        };
      }
      const skills: InstanceSkillSummary[] = rows.map((row) => ({
        id: row.skillId,
        name: row.slug,
        description: row.description,
        body: row.skillContent,
        path: "",
        scope: "workspace",
        enabled: row.enabled,
        resourceRef: `kenfutwork-skill:${row.skillId}`,
        metadata: { slug: row.slug },
      }));
      const result: SkillsListResult = {
        skills,
        capability: { userScopeAvailable: false },
        diagnostics: [],
      };
      return { result };
    },
  };
}
