import {
  codeTaskControllerMutationArgsSchema,
  codeTaskOrganizationArgsSchema,
  codeTaskPinArgsSchema,
  codeTaskPinObservationSchema,
  codeTaskUnreadArgsSchema,
  codeTaskUnreadObservationSchema,
} from "@kenfutwork/shared";
import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "./host-rpc-handler.js";

function registerTaskListMutationHandlers(ctx: PluginContext) {
  const service = ctx.get("codeUi");
  ctx.effect(() =>
    ctx
      .get("capabilities")
      .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
        id: "zcode-task.setTaskPinned",
        value: {
          call(actor, args, context) {
            return runCodeUiHostRpc(context, async () => {
              const [input] = codeTaskPinArgsSchema.parse(args);
              return service.changeTaskPinned(actor, input, context.signal);
            });
          },
        },
      }),
  );
  ctx.effect(() =>
    ctx
      .get("capabilities")
      .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
        id: "zcode-task.setTaskUnread",
        value: {
          call(actor, args, context) {
            return runCodeUiHostRpc(context, async () => {
              const [input] = codeTaskUnreadArgsSchema.parse(args);
              return service.changeTaskUnread(actor, input, context.signal);
            });
          },
        },
      }),
  );
  ctx.effect(() =>
    ctx
      .get("capabilities")
      .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
        id: "window-controller.mutateTask",
        value: {
          call(actor, args, context) {
            return runCodeUiHostRpc(context, async () => {
              const [{ address, mutation }] =
                codeTaskControllerMutationArgsSchema.parse(args);
              if (mutation.kind === "pin")
                return service.changeTaskPinned(
                  actor,
                  {
                    ...codeTaskPinObservationSchema.parse(address),
                    pinned: mutation.pinned,
                  },
                  context.signal,
                );
              return service.changeTaskUnread(
                actor,
                {
                  ...codeTaskUnreadObservationSchema.parse(address),
                  unread: mutation.kind === "mark-unread",
                  ...(mutation.kind === "mark-read" &&
                  mutation.expectedUnreadAt !== undefined
                    ? { expectedUnreadAt: mutation.expectedUnreadAt }
                    : {}),
                },
                context.signal,
              );
            });
          },
        },
      }),
  );
}

export function createTaskOrganizationPlugin(): PluginDefinition {
  return {
    name: "code-ui:task-organization",
    inject: ["codeUi", "capabilities"],
    apply() {},
    mounted(ctx) {
      const service = ctx.get("codeUi");
      registerTaskListMutationHandlers(ctx);
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
