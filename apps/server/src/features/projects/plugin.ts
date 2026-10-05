import { registerProjectRoutes } from "../../http/projects.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import { createProjectService } from "./project-service.js";
import { createProjectRepository } from "./repository.js";

/**
 * projects 插件：项目 CRUD + 缩略图服务 + HTTP 路由（路由注册放 mounted）。
 * 数据访问经 `persistence` 缝，缩略图经 `blob` 缝——不再持有旧账户客户端。
 */
export function createProjectsPlugin(): PluginDefinition {
  return {
    name: "projects",
    inject: ["localAccess", "blob", "persistence", "localInstance"],
    apply(ctx) {
      ctx.register("projects", () =>
        createProjectService({
          blob: ctx.get("blob"),
          repository: createProjectRepository(ctx.get("persistence")),
          localInstance: ctx.get("localInstance"),
          sandboxRoot: ctx.env.sandboxRoot,
          beforeArchiveCodeProject: async (actor, projectId) => {
            const context = await ctx.get("localInstance").resolve(actor);
            const roots = (
              await createCodeUiRepository(ctx.get("persistence")).listRoots(
                context.instanceId,
              )
            ).filter(
              (root) => root.project_id === projectId && !root.deleted_at,
            );
            const close = createTaskResourceCloser({
              localInstance: ctx.get("localInstance"),
              resources: () => ({
                runs: ctx.get("agentRuns"),
                work: ctx.get("taskWork"),
                sandbox: ctx.get("processSandbox"),
                capabilities: ctx.get("capabilities"),
              }),
            });
            const settled = await Promise.allSettled(
              roots.map((root) => close(actor, root.id, "项目已关闭")),
            );
            const failure = settled.find(
              (result) => result.status === "rejected",
            );
            if (failure?.status === "rejected") throw failure.reason;
          },
        }),
      );
    },
    mounted(ctx) {
      void registerProjectRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        projectService: ctx.get("projects"),
      });
    },
  };
}
