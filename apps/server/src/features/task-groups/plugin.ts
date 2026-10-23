import {
  codeTaskGroupReadArgsSchema,
  codeTaskGroupSaveArgsSchema,
} from "@kenfutwork/shared";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "../code-ui/host-rpc-handler.js";
import { createTaskGroupReader } from "./reader.js";
import { createTaskGroupWriter } from "./writer.js";

export function createTaskGroupsPlugin(): PluginDefinition {
  return {
    name: "code-ui:task-groups",
    inject: ["persistence", "localInstance", "capabilities", "codeUi"],
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
      const writer = createTaskGroupWriter({
        persistence: ctx.get("persistence"),
        localInstance: ctx.get("localInstance"),
      });
      ctx.effect(() =>
        ctx
          .get("capabilities")
          .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
            id: "task-groups.save",
            value: {
              call(actor, args, context) {
                return runCodeUiHostRpc(context, async () => {
                  const [input] = codeTaskGroupSaveArgsSchema.parse(args);
                  const result = await writer.save(
                    actor,
                    input,
                    context.signal,
                  );
                  await ctx.get("codeUi").refreshTaskGroups(actor);
                  return result;
                });
              },
            },
          }),
      );
    },
  };
}
