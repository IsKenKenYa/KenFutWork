import { registerProjectDirectoryRelinkRoutes } from "../../http/project-directory-relink.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import { createProjectDirectoryRelinkService } from "./directory-relink.js";

export function createProjectDirectoryRelinkPlugin(): PluginDefinition {
  return {
    name: "project-directory-relink",
    inject: [
      "localAccess",
      "localInstance",
      "persistence",
      "goals",
      "agentRuns",
      "taskWork",
      "processSandbox",
      "capabilities",
      "flowProjectControl",
    ],
    apply(ctx) {
      ctx.register("projectDirectoryRelink", () =>
        createProjectDirectoryRelinkService({
          flowProjectControl: ctx.get("flowProjectControl"),
          persistence: ctx.get("persistence"),
          localInstance: ctx.get("localInstance"),
          goals: ctx.get("goals"),
          closeResources: async (actor, taskId, reason, kind) => {
            await createTaskResourceCloser({
              localInstance: ctx.get("localInstance"),
              resources: () => ({
                runs: ctx.get("agentRuns"),
                work: ctx.get("taskWork"),
                sandbox: ctx.get("processSandbox"),
                capabilities: ctx.get("capabilities"),
              }),
            })(actor, taskId, reason, kind);
          },
        }),
      );
    },
    mounted(ctx) {
      ctx.app.addHook("onReady", async () => {
        await ctx.get("projectDirectoryRelink").initialize();
      });
      void registerProjectDirectoryRelinkRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        relink: ctx.get("projectDirectoryRelink"),
      });
    },
  };
}
