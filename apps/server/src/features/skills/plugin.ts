import { registerSkillRoutes } from "../../http/skills.js";
import { registerMarketplaceRoutes } from "../../http/skills-marketplace.js";
import type {
  PluginDefinition,
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { CODE_UI_HOST_RPC_CAPABILITY } from "../code-ui/host-rpc-handler.js";
import { projectWorkDirLoaderFor } from "../projects/work-dir.js";
import { createCodeUiSkillsHost } from "./code-ui-host.js";
import { createCreateSkillTool } from "./create-skill-tool.js";
import {
  createSkillCatalogRepository,
  type SkillCatalogRepository,
} from "./repository.js";
import {
  createSkillCatalogService,
  type SkillCatalogService,
} from "./skill-catalog-service.js";
import { resolveSkillActor } from "./skill-context.js";
import { createInstanceSkillResourceReader } from "./skill-resource-service.js";

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
    inject: [
      "localAccess",
      "persistence",
      "localInstance",
      "projects",
      "executionScopes",
    ],
    apply(ctx) {
      skillsRepository = createSkillCatalogRepository(ctx.get("persistence"));
      const catalog: SkillCatalogService = createSkillCatalogService({
        repository: skillsRepository,
        localInstance: ctx.get("localInstance"),
      });
      const resources = createInstanceSkillResourceReader({
        repository: skillsRepository,
        localInstance: ctx.get("localInstance"),
      });

      const listSkillsTool: ToolDefinition = {
        name: "list_skills",
        access: "read",
        exposure: "deferred",
        description: "列出当前实例已安装并启用的 skill（名称与描述）。",
        scope: "shared",
        parameters: { type: "object", properties: {} },
        execute: async (_args, execCtx: ToolExecutionContext) => {
          const actor = await resolveSkillActor(
            ctx.get("localInstance"),
            execCtx,
          );
          const skills = await catalog.listSkills(actor.instanceId);
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
          "读取实例已安装并启用的skill正文，或resource_path指定的包内只读附属资源。先list_skills；安装包不是本机路径，脚本须在Task授权目录审阅副本后通过受控Bash执行。",
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
          const actor = await resolveSkillActor(
            ctx.get("localInstance"),
            execCtx,
          );
          if (args.resource_path !== undefined) {
            if (typeof args.resource_path !== "string")
              throw new Error("resource_path需要包内相对路径字符串。");
            const resource = await resources.read(
              actor.instanceId,
              name,
              args.resource_path,
            );
            if (!resource)
              throw new Error(`skill ${name} 的资源未安装、已停用或不存在`);
            return resource;
          }
          const detail = await catalog.getSkill(actor.instanceId, name);
          if (!detail) {
            throw new Error(`skill ${name} 未安装或未启用`);
          }
          return detail;
        },
      };

      // 创造模式的收尾动作：把技能包发布到当前实例技能库（工厂在 create-skill-tool.ts）
      const createSkillTool: ToolDefinition = createCreateSkillTool({
        repository: skillsRepository,
        localInstance: ctx.get("localInstance"),
      });

      ctx.get("tools").register(listSkillsTool);
      ctx.get("tools").register(useSkillTool);
      ctx.get("tools").register(createSkillTool);
    },
    mounted(ctx) {
      for (const [id, value] of Object.entries(
        createCodeUiSkillsHost({
          localInstance: ctx.get("localInstance"),
          repository: skillsRepository,
        }),
      )) {
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register(CODE_UI_HOST_RPC_CAPABILITY, { id, value }),
        );
      }
      void registerSkillRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        skillsRepository,
        localInstance: ctx.get("localInstance"),
        canvasRepository: createCanvasRepository(ctx.get("persistence")),
        projects: ctx.get("projects"),
        executionScopes: ctx.get("executionScopes"),
        sandboxRoot: ctx.env.sandboxRoot,
        canvasWorkDirs: ctx.env.canvasWorkDirs,
        projectWorkDirLoader: projectWorkDirLoaderFor(ctx.get("persistence")),
      });
      void registerMarketplaceRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        skillsRepository,
        localInstance: ctx.get("localInstance"),
      });
    },
  };
}
