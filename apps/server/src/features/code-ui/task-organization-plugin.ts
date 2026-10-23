import { codeTaskOrganizationArgsSchema } from "@kenfutwork/shared";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "./host-rpc-handler.js";

export function createTaskOrganizationPlugin(): PluginDefinition {
  return {
    name: "code-ui:task-organization",
    inject: ["codeUi", "capabilities"],
    apply() {},
    mounted(ctx) {
      const service = ctx.get("codeUi");
      for (const method of [
        "archiveTask",
        "unarchiveTask",
        "deleteArchivedTask",
      ] as const)
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
              id: `zcode-task.${method}`,
              value: {
                async call(actor, args, context) {
                  return runCodeUiHostRpc(context, async () => {
                    const [target] = codeTaskOrganizationArgsSchema.parse(args);
                    return method === "deleteArchivedTask"
                      ? service.deleteArchivedTask(
                          actor,
                          target,
                          context.signal,
                        )
                      : service.changeTaskArchive(
                          actor,
                          target,
                          method === "archiveTask",
                          context.signal,
                        );
                  });
                },
              },
            }),
        );
    },
  };
}
