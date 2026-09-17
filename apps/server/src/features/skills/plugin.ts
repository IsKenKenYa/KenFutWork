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
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      skillsRepository = createSkillCatalogRepository(ctx.get("persistence"));
      const catalog: SkillCatalogService = createSkillCatalogService({
        repository: skillsRepository,
      });

      const listSkillsTool: ToolDefinition = {
        name: "list_skills",
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
        description:
          "读取指定 skill 的 SKILL.md 全文，按其指引完成任务。先用 list_skills 查看可用项。",
        scope: "shared",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "skill slug" },
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
