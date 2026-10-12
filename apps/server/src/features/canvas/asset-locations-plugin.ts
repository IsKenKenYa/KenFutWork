import { registerProjectFileRoutes } from "../../http/project-files.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCanvasAssetLocations } from "./asset-locations.js";
import { createCanvasRepository } from "./repository.js";

export function createCanvasAssetLocationsPlugin(): PluginDefinition {
  return {
    name: "canvas-assets",
    inject: [
      "localAccess",
      "persistence",
      "localInstance",
      "projects",
      "projectFiles",
      "settings",
    ],
    apply(ctx) {
      ctx.register("canvasAssets", () =>
        createCanvasAssetLocations({
          canvases: createCanvasRepository(ctx.get("persistence")),
          localInstance: ctx.get("localInstance"),
          projects: ctx.get("projects"),
          projectFiles: ctx.get("projectFiles"),
          exportMaxBytes: async (actor) =>
            (
              await ctx
                .get("settings")
                .getInstanceSettings(actor, actor.instanceId)
            ).canvasExportMaxBytes,
        }),
      );
    },
    mounted(ctx) {
      void registerProjectFileRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        projectFiles: ctx.get("projectFiles"),
        canvasAssets: ctx.get("canvasAssets"),
      });
    },
  };
}
