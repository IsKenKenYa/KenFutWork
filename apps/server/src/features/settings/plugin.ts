import { registerSettingsRoutes } from "../../http/settings.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { toInstanceSpecifier } from "../model-providers/model-catalog-service.js";
import { createSettingsRepository } from "./repository.js";
import { createSettingsService } from "./settings-service.js";

/**
 * settings 插件：用户偏好/默认模型设置服务 + HTTP 路由（路由消费 viewer）。
 *
 * 兜底默认模型取自**模型目录**（首个可用 chat 模型）而不是 env 里的内置目录名：
 * 目录是「本部署实际能调用的模型」的唯一事实源，env 名可能根本不存在于供应商实例
 * （平台池只配 GLM 时 `gpt-4.1` 会 404）。目录为空时再退回 `env.agentModel`。
 */
export function createSettingsPlugin(): PluginDefinition {
  return {
    name: "settings",
    inject: ["auth", "modelCatalog", "persistence", "viewer"],
    apply(ctx) {
      ctx.register("settings", () =>
        createSettingsService({
          defaultModel: ctx.env.agentModel,
          ...(ctx.env.agentGovernance
            ? { governanceEnv: ctx.env.agentGovernance }
            : {}),
          resolveFallbackModel: async (user) => {
            const entries = await ctx
              .get("modelCatalog")
              .listCatalog(user)
              .catch(() => []);
            const chatModel = entries.find(
              (entry) => entry.capability === "chat",
            );
            return chatModel ? toInstanceSpecifier(chatModel) : undefined;
          },
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
