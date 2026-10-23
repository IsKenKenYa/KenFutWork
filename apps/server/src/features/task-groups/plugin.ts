import { codeTaskGroupReadArgsSchema } from "@kenfutwork/shared";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "../code-ui/host-rpc-handler.js";
import { createTaskGroupReader } from "./reader.js";

export function createTaskGroupsPlugin(): PluginDefinition {
  return {
    name: "code-ui:task-groups",
    inject: ["persistence", "localInstance", "capabilities"],
    apply() {},
    mounted(ctx) {
      const service = createTaskGroupReader({
        persistence: ctx.get("persistence"),
        localInstance: ctx.get("localInstance"),
      });
      ctx.effect(() =>
        ctx
          .get("capabilities")
          .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
            id: "task-groups.read",
            value: {
              call(actor, args, context) {
                return runCodeUiHostRpc(context, () => {
                  codeTaskGroupReadArgsSchema.parse(args);
                  return service.read(actor, context.signal);
                });
              },
            },
          }),
      );
    },
  };
}
