import { registerProjectRoutes } from "../../http/projects.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createProjectService } from "./project-service.js";

/** projects 插件：项目 CRUD + 缩略图服务 + HTTP 路由（路由注册放 mounted）。 */
export function createProjectsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "projects",
    inject: ["auth", "viewer"],
    apply(ctx) {
      ctx.register("projects", () =>
        createProjectService({
          createUserClient: deps.createUserClient,
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
