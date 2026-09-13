import { registerProjectRoutes } from "../../http/projects.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createProjectService } from "./project-service.js";
import { createProjectRepository } from "./repository.js";

/**
 * projects 插件：项目 CRUD + 缩略图服务 + HTTP 路由（路由注册放 mounted）。
 * 数据访问经 `persistence` 缝，缩略图经 `blob` 缝——不再持有用户 Supabase 客户端。
 */
export function createProjectsPlugin(): PluginDefinition {
  return {
    name: "projects",
    inject: ["auth", "blob", "persistence", "viewer"],
    apply(ctx) {
      ctx.register("projects", () =>
        createProjectService({
          blob: ctx.get("blob"),
          repository: createProjectRepository(ctx.get("persistence")),
          viewerService: ctx.get("viewer"),
        }),
      );
    },
    mounted(ctx) {
      void registerProjectRoutes(ctx.app, {
        auth: ctx.get("auth"),
        projectService: ctx.get("projects"),
      });
    },
  };
}
