import { resolveDefaultAgentModel } from "../../config/env.js";
import { registerSettingsRoutes } from "../../http/settings.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createSettingsRepository } from "./repository.js";
import { createSettingsService } from "./settings-service.js";

/** settings 插件：用户偏好/默认模型设置服务 + HTTP 路由（路由消费 viewer）。 */
export function createSettingsPlugin(): PluginDefinition {
  return {
    name: "settings",
    inject: ["auth", "persistence", "viewer"],
    apply(ctx) {
      ctx.register("settings", () =>
        createSettingsService({
          defaultModel: resolveDefaultAgentModel(ctx.env),
          repository: createSettingsRepository(ctx.get("persistence")),
        }),
      );
    },
    mounted(ctx) {
      void registerSettingsRoutes(ctx.app, {
        auth: ctx.get("auth"),
        settingsService: ctx.get("settings"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
