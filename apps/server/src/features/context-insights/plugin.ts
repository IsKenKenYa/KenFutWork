import type { AgentRunExtension } from "../../agent/run-extension.js";
import type { PluginDefinition } from "../../kernel/types.js";
import {
  CODE_UI_HOST_RPC_CAPABILITY,
  type CodeUiHostRpcHandler,
  runCodeUiHostRpc,
} from "../code-ui/host-rpc-handler.js";
import { createContextRequestCallbacks } from "./capture.js";
import { createContextInspectionService } from "./service.js";

export function createContextInsightsPlugin(): PluginDefinition {
  return {
    name: "context-insights",
    inject: ["persistence", "localInstance", "settings", "capabilities"],
    apply(ctx) {
      const service = createContextInspectionService({
        persistence: ctx.get("persistence"),
        localInstance: ctx.get("localInstance"),
        async readPageCharacters(actor) {
          const settings = await ctx
            .get("settings")
            .getInstanceSettings(actor, actor.instanceId);
          return settings.codeReadPageCharacters;
        },
      });
      const extension: AgentRunExtension = {
        preset: "shared",
        createMiddleware: () => ({ name: "ContextInsights" }),
        createModelCallbacks(identity, context) {
          const execution = context?.execution;
          const scope = execution?.scopeHandle?.describe();
          if (!scope || !execution?.runId) return [];
          return [
            createContextRequestCallbacks(service.writer, {
              instanceId: scope.instanceId,
              taskId: scope.taskId,
              runId: execution.runId,
              ...identity,
            }),
          ];
        },
      };
      ctx.effect(() =>
        ctx.get("capabilities").register("agent-run-extension", {
          id: "context-insights:requests",
          value: extension,
        }),
      );
      for (const method of ["list", "read"] as const)
        ctx.effect(() =>
          ctx
            .get("capabilities")
            .register<CodeUiHostRpcHandler>(CODE_UI_HOST_RPC_CAPABILITY, {
              id: `context-insights.${method}`,
              value: {
                call(actor, args, context) {
                  return runCodeUiHostRpc<unknown>(context, () =>
                    service[method](actor, args[0]),
                  );
                },
              },
            }),
        );
    },
  };
}
