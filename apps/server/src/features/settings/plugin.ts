import { registerSettingsRoutes } from "../../http/settings.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { toInstanceSpecifier } from "../model-providers/model-catalog-service.js";
import { createSettingsRepository } from "./repository.js";
import { createSettingsService } from "./settings-service.js";

/** 设置服务只依赖实例、模型目录及存储；本机访问门可据此读取治理值。 */
export function createSettingsPlugin(): PluginDefinition {
  return {
    name: "settings",
    inject: ["localInstance", "modelCatalog", "persistence"],
    apply(ctx) {
      ctx.register("settings", () =>
        createSettingsService({
          localInstance: ctx.get("localInstance"),
          modelCatalog: {
            listCatalog: (actor) => ctx.get("modelCatalog").listCatalog(actor),
          },
          defaultModel: ctx.env.agentModel,
          ...(ctx.env.agentGovernance
            ? { governanceEnv: ctx.env.agentGovernance }
            : {}),
          resolveFallbackModel: async (actor) => {
            const entries = await ctx
              .get("modelCatalog")
              .listCatalog(actor)
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
  };
}

/** HTTP 消费方在服务图就绪后挂载，不进入设置服务的依赖图。 */
export function createSettingsRoutesPlugin(): PluginDefinition {
  return {
    name: "settings:http",
    inject: ["settings", "localAccess", "localInstance", "modelCatalog"],
    apply() {},
    mounted(ctx) {
      void registerSettingsRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        localInstance: ctx.get("localInstance"),
        settingsService: ctx.get("settings"),
        modelCatalog: ctx.get("modelCatalog"),
      });
    },
  };
}
