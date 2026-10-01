import { registerBrandKitRoutes } from "../../http/brand-kits.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createCanvasRepository } from "../canvas/repository.js";
import { createBrandKitService } from "./brand-kit-service.js";
import { createBrandKitToolDefinition } from "./brand-kit-tool.js";
import { brandKitPromptSection } from "./prompt.js";
import { createBrandKitRepository } from "./repository.js";

/**
 * brand-kit 插件（P2 试点）：服务定义 + Provider + Consumer（HTTP 路由 +
 * `get_brand_kit` 工具 + 品牌提示段）内聚。测试注入用 kernel overrides 替换
 * brandKit 服务实例。工具注册权在属主 feature（§4.10）：scope=design，套件绑定
 * 由画布→项目 JOIN 在 execute 期从 execCtx 重推导。
 */
export const brandKitPlugin: PluginDefinition = {
  name: "brand-kit",
  inject: ["auth", "blob", "persistence"],
  apply(ctx) {
    ctx.register("brandKit", () =>
      createBrandKitService({
        blob: ctx.get("blob"),
        repository: createBrandKitRepository(ctx.get("persistence")),
      }),
    );
    ctx.get("tools").register(
      createBrandKitToolDefinition({
        // apply 内取即实例化（纯构造无 IO；compose 启动期本就强制全量定例化）
        brandKitService: ctx.get("brandKit"),
        canvasRepository: createCanvasRepository(ctx.get("persistence")),
      }),
    );
    // 品牌段：与 get_brand_kit 工具同属主（design + 已绑定才出现）
    ctx.get("systemPrompt").register(brandKitPromptSection);
    void registerBrandKitRoutes(ctx.app, {
      auth: ctx.get("auth"),
      brandKitService: ctx.get("brandKit"),
    });
  },
};
