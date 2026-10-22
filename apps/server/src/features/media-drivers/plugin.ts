import { registerMediaDriverRoutes } from "../../http/media-drivers.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createMediaDriverService } from "./service.js";

export function createMediaDriversPlugin(): PluginDefinition {
  return {
    name: "media-drivers",
    inject: ["localInstance", "settings"],
    apply(ctx) {
      ctx.register("mediaDrivers", () =>
        createMediaDriverService({
          localInstance: ctx.get("localInstance"),
          settings: ctx.get("settings"),
        }),
      );
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
