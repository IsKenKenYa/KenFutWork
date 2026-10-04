import { registerSkillRoutes } from "../../http/skills.js";
import { registerMarketplaceRoutes } from "../../http/skills-marketplace.js";
import type {
  PluginDefinition,
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { projectWorkDirLoaderFor } from "../projects/work-dir.js";
import { createCreateSkillTool } from "./create-skill-tool.js";
import {
  createSkillCatalogRepository,
  type SkillCatalogRepository,
} from "./repository.js";
import {
  createSkillCatalogService,
  type SkillCatalogService,
} from "./skill-catalog-service.js";
import { createWorkspaceSkillResourceReader } from "./skill-resource-service.js";

/**
 * skills 插件：技能导入 + 市场路由（HTTP 面）+ **skill 工具缝**（P5）。
 * SKILL.md 发现经 SkillCatalogService 向 `ctx.tools` 贡献 `list_skills` /
 * `use_skill`（shared scope，design/code 两 preset 均可用），与 SkillsMiddleware
 * 的提示注入同源数据、互为补充。
 * HTTP 路由与工具同走 `SkillCatalogRepository`：不再持有用户 Supabase 客户端。
 */
export function createSkillsPlugin(): PluginDefinition {
  // apply 期构造、mounted 期复用（同一实例）
  let skillsRepository: SkillCatalogRepository;
  return {
    name: "skills",
    inject: ["auth", "persistence", "viewer", "projects", "executionScopes"],
    apply(ctx) {
      skillsRepository = createSkillCatalogRepository(ctx.get("persistence"));
      const catalog: SkillCatalogService = createSkillCatalogService({
        repository: skillsRepository,
      });
      const resources = createWorkspaceSkillResourceReader({
        repository: skillsRepository,
      });

      const listSkillsTool: ToolDefinition = {
        name: "list_skills",
        access: "read",
        exposure: "deferred",
        description: "列出当前工作区已安装并启用的 skill（名称与描述）。",
        scope: "shared",
        parameters: { type: "object", properties: {} },
        execute: async (_args, execCtx: ToolExecutionContext) => {
          if (!execCtx.workspaceId) {
            // 不再静默返回空列表：缺工作区上下文必须说清原因
            return {
              skills: [],
              hint: "当前执行上下文缺少工作区，无法读取 skill 目录。",
            };
          }
          const skills = await catalog.listSkills(execCtx.workspaceId);
          return {
            skills: skills
              .filter((s) => s.enabled)
              .map((s) => ({ name: s.name, description: s.description })),
          };
        },
      };

      const useSkillTool: ToolDefinition = {
        name: "use_skill",
        access: "read",
        exposure: "deferred",
        description:
          "读取工作区已安装并启用的skill正文，或resource_path指定的包内只读附属资源。先list_skills；安装包不是本机路径，脚本须在Task授权目录审阅副本后通过受控Bash执行。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "skill slug" },
            resource_path: {
              type: "string",
              description:
                "可选，技能包内canonical相对路径，如scripts/check.ts；不接受绝对路径或../",
            },
          },
          required: ["name"],
        },
        execute: async (args, execCtx: ToolExecutionContext) => {
          const name = String(args.name ?? "");
          if (!name) {
            throw new Error("use_skill 需要 name 参数");
          }
          if (!execCtx.workspaceId) {
            throw new Error("当前执行上下文缺少工作区，无法读取 skill。");
          }
          if (
            execCtx.scopeHandle &&
            execCtx.scopeHandle.describe().workspaceId !== execCtx.workspaceId
          )
            throw new Error("技能工作区与可信Task工作域不匹配。");
          if (args.resource_path !== undefined) {
            if (typeof args.resource_path !== "string")
              throw new Error("resource_path需要包内相对路径字符串。");
            const resource = await resources.read(
              execCtx.workspaceId,
              name,
              args.resource_path,
            );
            if (!resource)
              throw new Error(`skill ${name} 的资源未安装、已停用或不存在`);
            return resource;
          }
          const detail = await catalog.getSkill(execCtx.workspaceId, name);
          if (!detail) {
            throw new Error(`skill ${name} 未安装或未启用`);
          }
          return detail;
        },
      };

      // 创造模式的收尾动作：把技能包发布到当前工作区技能库（工厂在 create-skill-tool.ts）
      const createSkillTool: ToolDefinition = createCreateSkillTool({
        repository: skillsRepository,
        auth: ctx.get("auth"),
      });

      ctx.get("tools").register(listSkillsTool);
      ctx.get("tools").register(useSkillTool);
      ctx.get("tools").register(createSkillTool);
    },
    mounted(ctx) {
      void registerSkillRoutes(ctx.app, {
        auth: ctx.get("auth"),
        skillsRepository,
        viewerService: ctx.get("viewer"),
        canvasRepository: createCanvasRepository(ctx.get("persistence")),
        projects: ctx.get("projects"),
        executionScopes: ctx.get("executionScopes"),
        sandboxRoot: ctx.env.sandboxRoot,
        canvasWorkDirs: ctx.env.canvasWorkDirs,
        projectWorkDirLoader: projectWorkDirLoaderFor(ctx.get("persistence")),
      });
      void registerMarketplaceRoutes(ctx.app, {
        auth: ctx.get("auth"),
        skillsRepository,
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
