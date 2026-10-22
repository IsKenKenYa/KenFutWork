import type { PluginDefinition } from "../../kernel/types.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
} from "./host-rpc-handler.js";
import { createTaskProjectMoveService } from "./task-project-move.js";
import { taskProjectMoveInputSchema } from "./task-project-move-types.js";

export function createTaskProjectMovePlugin(): PluginDefinition {
  return {
    name: "code-ui:task-project-move",
    inject: [
      "codeUi",
      "persistence",
      "localInstance",
      "executionScopes",
      "agentRuns",
      "taskWork",
      "processSandbox",
      "capabilities",
    ],
    apply() {},
    mounted(ctx) {
      const closeTask = createTaskResourceCloser({
        localInstance: ctx.get("localInstance"),
        resources: () => ({
          runs: ctx.get("agentRuns"),
          work: ctx.get("taskWork"),
          sandbox: ctx.get("processSandbox"),
          capabilities: ctx.get("capabilities"),
        }),
      });
      const service = createTaskProjectMoveService({
        persistence: ctx.get("persistence"),
        localInstance: ctx.get("localInstance"),
        executionScopes: ctx.get("executionScopes"),
        closeTask: (actor, taskId) => closeTask(actor, taskId, "project.move"),
        afterMove: (actor, event) =>
          ctx.get("codeUi").refreshMovedTask(actor, event),
      });
      ctx.effect(() =>
        ctx
          .get("capabilities")
          .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
            id: "project.moveTask",
            value: {
              async call(actor, args, context) {
                context.requireInitialized();
                await service.moveTask(
                  actor,
                  taskProjectMoveInputSchema.parse(args[0]),
                );
                return null;
              },
            },
          }),
      );
      ctx.effect(() => () => service.close());
    },
  };
}
