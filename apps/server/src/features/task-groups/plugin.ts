import {
  codeTaskGroupAdmissionArgsSchema,
  codeTaskGroupReadArgsSchema,
  codeTaskGroupSaveArgsSchema,
  codeTaskGroupUngroupArgsSchema,
} from "@kenfutwork/shared";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "../code-ui/host-rpc-handler.js";
import { createTaskGroupAdmission } from "./admission.js";
import { createTaskGroupReader } from "./reader.js";
import { createTaskGroupUngrouper } from "./ungroup.js";
import { createTaskGroupWriter } from "./writer.js";

export function createTaskGroupsPlugin(): PluginDefinition {
  return {
    name: "code-ui:task-groups",
    inject: ["persistence", "localInstance", "capabilities", "codeUi"],
    apply() {},
    mounted(ctx) {
      const dependencies = {
        persistence: ctx.get("persistence"),
        localInstance: ctx.get("localInstance"),
      };
      const reader = createTaskGroupReader(dependencies);
      const writer = createTaskGroupWriter(dependencies);
      const ungrouper = createTaskGroupUngrouper(dependencies);
      const admission = createTaskGroupAdmission(dependencies);
      const methods: Record<string, CodeUiHostRpcHandler["call"]> = {
        async read(actor, args, context) {
          codeTaskGroupReadArgsSchema.parse(args);
          return reader.read(actor, context.signal);
        },
        async save(actor, args, context) {
          const [input] = codeTaskGroupSaveArgsSchema.parse(args);
          const result = await writer.save(actor, input, context.signal);
          await ctx.get("codeUi").refreshTaskGroups(actor);
          return result;
        },
        async ungroup(actor, args, context) {
          const [input] = codeTaskGroupUngroupArgsSchema.parse(args);
          await ungrouper.ungroup(actor, input, context.signal);
          await ctx.get("codeUi").refreshTaskGroups(actor);
          return null;
        },
        async admit(actor, args, context) {
          const [input] = codeTaskGroupAdmissionArgsSchema.parse(args);
          const changed = await admission.admit(actor, input, context.signal);
          if (changed) await ctx.get("codeUi").refreshTaskGroups(actor);
          return null;
        },
      };
      for (const [method, call] of Object.entries(methods))
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
              id: `task-groups.${method}`,
              value: {
                call(actor, args, context) {
                  return runCodeUiHostRpc(context, () =>
                    call(actor, args, context),
                  );
                },
              },
            }),
        );
    },
  };
}
