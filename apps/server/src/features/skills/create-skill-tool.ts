import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import type { RequestAuthenticator } from "../auth/types.js";
import type { SkillCatalogRepository } from "./repository.js";
import { buildSkillFromFiles } from "./skill-import-service.js";
import { generateSlug } from "./slug.js";

/**
 * `create_skill` 工具：把技能包**发布到当前工作区技能库**（创造模式的收尾动作）。
 *
 * 抽成工厂（而不是内联在插件里）是为了可测：插件只负责接线，本模块只依赖
 * 「仓库 + 认证缝」两个接口，单测直接注入假实现即可覆盖成功/缺工作区/缺凭据/坏 frontmatter。
 *
 * 走的是与「从工作目录导入」「ZIP 导入」同一条持久化路径（insertOwned + 附带文件 +
 * upsertInstallation），所以三处不会各自漂移。
 */
export function createCreateSkillTool(options: {
  repository: SkillCatalogRepository;
  auth: RequestAuthenticator;
}): ToolDefinition {
  return {
    name: "create_skill",
    description:
      "把刚写好的技能包**发布到当前工作区技能库**（写入 SKILL.md 全文与可选附带文件），发布即启用、下一次会话即可用。用于「创造」模式：先在沙箱里写出 SKILL.md，再用本工具发布；名称重复会失败，需换名。",
    scope: "shared",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名（也作为 slug 来源；建议小写中划线）",
        },
        description: {
          type: "string",
          description: "一句话说明这个技能做什么、什么时候用",
        },
        content: {
          type: "string",
          description:
            "SKILL.md 全文，必须以 YAML frontmatter 开头（---\\nname: …\\ndescription: …\\n---）",
        },
        files: {
          type: "array",
          description:
            "可选附带文件（只有 scripts/、references/、assets/ 下的文本文件会被保留）",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "相对技能包根的路径，如 scripts/run.py",
              },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["name", "description", "content"],
    },
    execute: async (args, execCtx: ToolExecutionContext) => {
      if (!execCtx.workspaceId) {
        throw new Error("当前执行上下文缺少工作区，无法发布技能。");
      }
      // 工具没有用户对象：用 run 带下来的访问令牌换（与 HTTP 路由同一认证缝）
      const user = execCtx.accessToken
        ? await options.auth
            .authenticate({
              headers: { authorization: `Bearer ${execCtx.accessToken}` },
            })
            .catch(() => null)
        : null;
      if (!user) {
        throw new Error("当前执行上下文缺少用户凭据，无法发布技能。");
      }

      const name = String(args.name ?? "").trim();
      const description = String(args.description ?? "").trim();
      const content = String(args.content ?? "");
      if (!name || !description || !content) {
        throw new Error("create_skill 需要 name / description / content。");
      }
      const extraFiles = Array.isArray(args.files)
        ? (args.files as Array<{ path?: unknown; content?: unknown }>)
            .map((file) => ({
              path: String(file?.path ?? ""),
              content: String(file?.content ?? ""),
            }))
            .filter((file) => file.path && file.content)
        : [];

      // 与「从工作目录导入」共用构建器：frontmatter 校验与附带文件过滤口径一致
      const imported = buildSkillFromFiles(
        [{ path: "SKILL.md", content }, ...extraFiles],
        { label: "sandbox", url: `create_skill:${name}` },
      );

      const slug = generateSlug(imported.manifest.name || name);
      const skillRow = await options.repository.insertOwned(user.id, {
        author: imported.manifest.author ?? "assistant",
        category: "custom",
        description: imported.manifest.description || description,
        license: imported.manifest.license ?? null,
        metadata: { source_url: imported.sourceUrl },
        name: imported.manifest.name || name,
        skillContent: imported.skillContent,
        slug,
        version: imported.manifest.version ?? "1.0",
      });
      if (!skillRow) {
        throw new Error("发布技能失败：写入技能库未成功。");
      }
      const skillId = skillRow.id as string;
      if (imported.files.length > 0) {
        await options.repository
          .insertFilesForOwnedSkill(user.id, skillId, imported.files)
          .catch(() => 0);
      }
      await options.repository.upsertInstallation({
        enabled: true,
        installedBy: user.id,
        skillId,
        workspaceId: execCtx.workspaceId,
      });

      return {
        installed: true,
        name: imported.manifest.name || name,
        slug,
        skillId,
        files: imported.files.length,
        hint: "技能已发布到当前工作区并启用：用户可在「技能」面板看到，后续会话用 use_skill 即可读取。",
      };
    },
  };
}
