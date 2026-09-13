import { registerProjectRoutes } from "../../http/projects.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createProjectService } from "./project-service.js";
import { createProjectRepository } from "./repository.js";

/**
 * projects 插件：项目 CRUD + 缩略图服务 + HTTP 路由（路由注册放 mounted）。
 * 数据访问经 `persistence` 缝；`createUserClient` 仅剩缩略图存储用途，
 * 随 M3 blob 缝落地移除。
 */
export function createProjectsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "projects",
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      ctx.register("projects", () =>
        createProjectService({
          createUserClient: deps.createUserClient,
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
