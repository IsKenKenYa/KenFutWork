import {
  pluginInspectRequestSchema,
  pluginInspectResponseSchema,
  pluginInstallRequestSchema,
  pluginInstallResponseSchema,
} from "@kenfutwork/shared";
import { z } from "zod";
import type { CodeUiHostRpcHandler } from "../code-ui/host-rpc-handler.js";
import type { LocalInstanceService } from "../local-instance/types.js";
import type { PluginRegistryService } from "./plugin-registry-service.js";

/** 原市场来源操作与REST共用现有注册表，不创建Project或Task。 */
export function createCodeUiPluginSourceHost(deps: {
  localInstance: LocalInstanceService;
  registry: PluginRegistryService;
}): Record<string, CodeUiHostRpcHandler> {
  return {
    "plugin-management.inspectPluginSource": {
      async call(actor, args) {
        await deps.localInstance.resolve(actor);
        const input = pluginInspectRequestSchema.strict().parse(args[0]);
        return pluginInspectResponseSchema.parse(
          await deps.registry.inspect(input),
        );
      },
    },
    "plugin-management.installPluginFromSource": {
      async call(actor, args) {
        await deps.localInstance.resolve(actor);
        const input = pluginInstallRequestSchema
          .extend({ allowLifecycleScripts: z.literal(false).default(false) })
          .strict()
          .parse(args[0]);
        return pluginInstallResponseSchema.parse(
          await deps.registry.install({ ...input, activation: "preserve" }),
        );
      },
    },
  };
}
