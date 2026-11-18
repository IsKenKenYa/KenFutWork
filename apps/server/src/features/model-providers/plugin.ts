import { registerModelCatalogRoutes } from "../../http/model-catalog.js";
import { registerProviderInstanceRoutes } from "../../http/provider-instances.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createModelCatalogService } from "./model-catalog-service.js";
import type { ModelProviderService } from "./model-provider-service.js";
import { createModelProviderService } from "./model-provider-service.js";
import { loadBundledModelsDevSnapshot } from "./models-dev-bundled.js";
import { createModelProviderRepository } from "./repository.js";

/** BYOK 服务装配不依赖本机访问门，避免 access → settings → catalog 的环。 */
export function createModelProvidersPlugin(
  deps: {
    /** 测试替身：直接作为 modelProviders 缝实例（跳过真实仓储装配）。 */
    injectedModelProviders?: ModelProviderService;
  } = {},
): PluginDefinition {
  return {
    name: "model-providers",
    inject: ["persistence", "localInstance"],
    apply(ctx) {
      ctx.register(
        "modelProviders",
        () =>
          deps.injectedModelProviders ??
          createModelProviderService({
            repository: createModelProviderRepository(ctx.get("persistence")),
            localInstance: ctx.get("localInstance"),
          }),
      );
      ctx.register("modelCatalog", () => {
        const snapshot = loadBundledModelsDevSnapshot();
        return createModelCatalogService({
          modelProviders: ctx.get("modelProviders"),
          localInstance: ctx.get("localInstance"),
          ...(snapshot ? { snapshot } : {}),
        });
      });
    },
  };
}

/** HTTP 消费方独立挂载，worker 只装配 BYOK 服务插件。 */
export function createModelProviderRoutesPlugin(): PluginDefinition {
  return {
    name: "model-providers:http",
    inject: ["localAccess", "modelProviders", "modelCatalog"],
    apply() {},
    mounted(ctx) {
      void registerProviderInstanceRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        modelProviders: ctx.get("modelProviders"),
      });
      void registerModelCatalogRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        modelCatalog: ctx.get("modelCatalog"),
      });
    },
  };
}
