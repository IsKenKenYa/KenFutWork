import { registerModelCatalogRoutes } from "../../http/model-catalog.js";
import { registerProviderInstanceRoutes } from "../../http/provider-instances.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import { createModelCatalogService } from "./model-catalog-service.js";
import { createModelProviderService } from "./model-provider-service.js";

/**
 * model-providers 插件（P4）：BYOK 供应商缝三元组。
 * - modelProviders：用户实例 CRUD + 凭证解析（SecretStore 加密落库，DEC-7）
 * - modelCatalog：从实例推导模型目录
 * - Consumer：provider-instances / model-catalog HTTP 路由；agent 链路与生成
 *   executor 按实例经 providers/resolve.ts 实例化适配器（P4 后续接线）。
 */
export function createModelProvidersPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  credentialEnv: { credentialSecret?: string };
}): PluginDefinition {
  return {
    name: "model-providers",
    inject: ["auth"],
    apply(ctx) {
      ctx.register("modelProviders", () =>
        createModelProviderService({
          createUserClient: deps.createUserClient,
          credentialEnv: deps.credentialEnv,
        }),
      );
      ctx.register("modelCatalog", () =>
        createModelCatalogService({
          modelProviders: ctx.get("modelProviders"),
        }),
      );
    },
    mounted(ctx) {
      void registerProviderInstanceRoutes(ctx.app, {
        auth: ctx.get("auth"),
        modelProviders: ctx.get("modelProviders"),
      });
      void registerModelCatalogRoutes(ctx.app, {
        auth: ctx.get("auth"),
        modelCatalog: ctx.get("modelCatalog"),
      });
    },
  };
}
