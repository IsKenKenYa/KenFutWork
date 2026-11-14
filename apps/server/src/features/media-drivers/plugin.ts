import { registerMediaDriverRoutes } from "../../http/media-drivers.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createMediaDriverRepository } from "./repository.js";
import { createMediaDriverService } from "./service.js";

export function createMediaDriversPlugin(): PluginDefinition {
  return {
    name: "media-drivers",
    inject: ["localInstance", "settings", "persistence"],
    apply(ctx) {
      ctx.register("mediaDrivers", () =>
        createMediaDriverService({
          localInstance: ctx.get("localInstance"),
          settings: ctx.get("settings"),
          repository: createMediaDriverRepository(ctx.get("persistence")),
        }),
      );
    },
    mounted(ctx) {
      ctx.app.addHook("onReady", async () => ctx.get("mediaDrivers").recover());
    },
  };
}

export function createMediaDriverRoutesPlugin(): PluginDefinition {
  return {
    name: "media-drivers:http",
    inject: ["localAccess", "mediaDrivers"],
    apply() {},
    mounted(ctx) {
      void registerMediaDriverRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        mediaDrivers: ctx.get("mediaDrivers"),
      });
    },
  };
}
