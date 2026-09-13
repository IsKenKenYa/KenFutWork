import { registerCreditRoutes } from "../../http/credits.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createJobRepository } from "../jobs/repository.js";
import { createCreditService } from "./credit-service.js";
import { createCreditRepository } from "./repository.js";
import { createTierGuard } from "./tier-guard.js";

/**
 * credits 插件：计费三件套中的 credits + tierGuard（payments 独立成插件）。
 * DEC-5：目标态（桌面/自托管）默认关闭；迁移期保持恒启用，行为不变。
 * 路由消费 viewer 服务，inject 声明 viewer；路由注册放 mounted。
 */
export function createCreditsPlugin(
  deps: {
    /** HTTP 进程挂路由（需 auth/viewer）；worker 进程只取服务，传 false。 */
    withRoutes?: boolean;
  } = {},
): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "credits",
    inject: withRoutes ? ["auth", "persistence", "viewer"] : ["persistence"],
    apply(ctx) {
      const persistence = ctx.get("persistence");
      // 并发检查读 background_jobs：数据访问归 jobs 聚合，这里只借它的计数入口。
      const jobRepository = createJobRepository(persistence);

      ctx.register("credits", () =>
        createCreditService({
          repository: createCreditRepository(persistence),
        }),
      );
      ctx.register("tierGuard", () =>
        createTierGuard({
          countActiveJobs: (workspaceId) =>
            jobRepository.countActive(workspaceId),
        }),
      );
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      void registerCreditRoutes(ctx.app, {
        auth: ctx.get("auth"),
        creditService: ctx.get("credits"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
