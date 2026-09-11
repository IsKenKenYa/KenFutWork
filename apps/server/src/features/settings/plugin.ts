import { resolveDefaultAgentModel } from "../../config/env.js";
import { registerSettingsRoutes } from "../../http/settings.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createSettingsService } from "./settings-service.js";

/** settings 插件：用户偏好/默认模型设置服务 + HTTP 路由（路由消费 viewer）。 */
export function createSettingsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "settings",
    inject: ["auth", "viewer"],
    apply(ctx) {
      ctx.register("settings", () =>
        createSettingsService({
          createUserClient: deps.createUserClient,
          defaultModel: resolveDefaultAgentModel(ctx.env),
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
