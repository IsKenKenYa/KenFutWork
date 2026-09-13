import { registerModelCatalogRoutes } from "../../http/model-catalog.js";
import { registerProviderInstanceRoutes } from "../../http/provider-instances.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createModelCatalogService } from "./model-catalog-service.js";
import { createModelProviderService } from "./model-provider-service.js";
import { createModelProviderRepository } from "./repository.js";

/**
 * model-providers 插件（P4）：BYOK 供应商缝三元组。
 * - modelProviders：用户实例 CRUD + 凭证解析（SecretStore 加密落库，DEC-7）
 * - modelCatalog：从实例推导模型目录
 * - Consumer：provider-instances / model-catalog HTTP 路由；agent 链路与生成
 *   executor 按实例经 providers/resolve.ts 实例化适配器（P4 后续接线）
 *
 * 数据访问经 `persistence` 缝：工作区实例走工作区作用域，平台池实例按
 * `scope='system'` 限定（原先靠「用户客户端 vs 服务角色客户端」区分，现已统一为
 * 单一信任角色 + 显式谓词）。
 */
export function createModelProvidersPlugin(deps: {
  credentialEnv: { credentialSecret?: string };
  /** HTTP 进程挂路由（需 auth）；worker 传 false。 */
  withRoutes?: boolean;
}): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "model-providers",
    // worker 无 HTTP 面、也无 auth/viewer：工作区级方法在那里不可用，
    // 缺 viewer 时由服务 fail loud（不静默）。
    inject: withRoutes ? ["auth", "persistence", "viewer"] : ["persistence"],
    apply(ctx) {
      const viewerService = ctx.tryGet("viewer");
      ctx.register("modelProviders", () =>
        createModelProviderService({
          credentialEnv: deps.credentialEnv,
          repository: createModelProviderRepository(ctx.get("persistence")),
          ...(viewerService ? { viewerService } : {}),
        }),
      );
      ctx.register("modelCatalog", () =>
        createModelCatalogService({
          modelProviders: ctx.get("modelProviders"),
        }),
      );
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
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
