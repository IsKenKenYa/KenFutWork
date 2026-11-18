import { resolveDataLocationPointerFile } from "../../desktop/paths.js";
import { registerInstanceRoutes } from "../../http/instance.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createDataLocationController } from "./data-control.js";

export function createInstanceRoutesPlugin(): PluginDefinition {
  return {
    name: "local-instance:http",
    inject: ["localInstance", "localAccess"],
    apply() {},
    mounted(ctx) {
      const localInstance = ctx.get("localInstance");
      const localAccess = ctx.get("localAccess");
      return registerInstanceRoutes(ctx.app, {
        localInstance,
        localAccess,
        dataControl: createDataLocationController({
          localInstance,
          localAccess,
          pointerFile: resolveDataLocationPointerFile({ env: process.env }),
        }),
      });
    },
  };
}
