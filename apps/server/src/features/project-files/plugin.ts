import type { PluginDefinition } from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createProjectFileRepository } from "./repository.js";
import { createProjectFileService } from "./service.js";

export function createProjectFilesPlugin(): PluginDefinition {
  return {
    name: "projectFiles",
    inject: [
      "blob",
      "persistence",
      "localInstance",
      "projects",
      "executionScopes",
    ],
    apply(ctx) {
      const service = createProjectFileService({
        repository: createProjectFileRepository(ctx.get("persistence")),
        localInstance: ctx.get("localInstance"),
        projects: ctx.get("projects"),
        executionScopes: ctx.get("executionScopes"),
        canvases: createCanvasRepository(ctx.get("persistence")),
      });
      ctx.get("blob").registerNamespace({
        bucket: "project-assets",
        namespace: "project-files",
        provider: service.namespaceProvider,
        publicRead: false,
      });
      ctx.register("projectFiles", () => service);
    },
  };
}
