import type { PluginDefinition } from "../../kernel/types.js";
import { createTaskResourceCloser } from "../task-work/close-resources.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "./host-rpc-handler.js";
import { createTaskProjectMoveService } from "./task-project-move.js";
import { taskProjectMoveArgsSchema } from "./task-project-move-types.js";

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
                return runCodeUiHostRpc(context, async () => {
                  const [input] = taskProjectMoveArgsSchema.parse(args);
                  await service.moveTask(actor, input, context.signal);
                  return null;
                });
              },
            },
          }),
      );
      ctx.effect(() => () => service.close());
    },
  };
}
