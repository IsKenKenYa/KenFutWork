import { registerProjectRoutes } from "../../http/projects.js";
import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import { createCodeUiRepository } from "../code-ui/repository.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import {
  createProjectService,
  ProjectServiceError,
} from "./project-service.js";
import { createProjectRepository } from "./repository.js";

type ProjectArchiveConsumers = Pick<
  Parameters<typeof createProjectService>[0],
  "beforeArchiveCodeProject"
>;

/** Archive closing is an HTTP/server consumer; the queue worker only reads projects. */
function createProjectArchiveConsumers(
  ctx: PluginContext,
): ProjectArchiveConsumers {
  const close = createTaskResourceCloser({
    localInstance: ctx.get("localInstance"),
    resources: () => ({
      runs: ctx.get("agentRuns"),
      work: ctx.get("taskWork"),
      sandbox: ctx.get("processSandbox"),
      capabilities: ctx.get("capabilities"),
    }),
  });
  return {
    beforeArchiveCodeProject: async (actor, projectId) => {
      const context = await ctx.get("localInstance").resolve(actor);
      const roots = (
        await createCodeUiRepository(ctx.get("persistence")).listRoots(
          context.instanceId,
        )
      ).filter((root) => root.project_id === projectId && !root.deleted_at);
      const settled = await Promise.allSettled(
        roots.map((root) => close(actor, root.id, "项目已关闭")),
      );
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}

/**
 * projects 插件：项目服务与可选HTTP路由。
 * 无路由的worker形态只提供查询Consumer，归档入口对所有kind明确关闭。
 */
export function createProjectsPlugin(
  options: { withRoutes?: boolean } = {},
): PluginDefinition {
  const withRoutes = options.withRoutes ?? true;
  return {
    name: "projects",
    inject: withRoutes
      ? [
          "localAccess",
          "blob",
          "persistence",
          "localInstance",
          "agentRuns",
          "taskWork",
          "processSandbox",
          "capabilities",
        ]
      : ["blob", "persistence", "localInstance"],
    apply(ctx) {
      const archiveConsumers = withRoutes
        ? createProjectArchiveConsumers(ctx)
        : {};
      ctx.register("projects", () => {
        const projects = createProjectService({
          blob: ctx.get("blob"),
          repository: createProjectRepository(ctx.get("persistence")),
          localInstance: ctx.get("localInstance"),
          sandboxRoot: ctx.env.sandboxRoot,
          ...archiveConsumers,
        });
        if (withRoutes) return projects;
        return {
          ...projects,
          async archiveProject() {
            throw new ProjectServiceError(
              "project_delete_failed",
              "项目关闭服务不可用，请在工作台归档。",
              503,
            );
          },
        };
      });
    },
    mounted(ctx) {
      if (!withRoutes) return;
      void registerProjectRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        projectService: ctx.get("projects"),
      });
    },
  };
}
