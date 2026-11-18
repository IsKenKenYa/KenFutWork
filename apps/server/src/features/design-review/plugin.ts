import { registerDesignReviewRoutes } from "../../http/design-review.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createDesignReviewService } from "./design-review-service.js";
import { createDesignReviewRepository } from "./repository.js";

/**
 * design-review 插件：画布评论与标注的数据面。
 *
 * 三元组完整：Service Definition（`DesignReviewService`）+ Provider（本插件
 * `ctx.register`）+ Consumer（HTTP 路由；面板是唯一消费方）。
 *
 * 刻意**不**复用上游 daemon 的 comments API：那套绑 conversation、带 workspace
 * 团队鉴权与云端 relay，与本地优先免账户（`DEC-20`）不是一个形态；本仓的评论与
 * 标注归本仓的库，上游应用内运行时继续用它自己的。
 */
export const designReviewPlugin: PluginDefinition = {
  name: "design-review",
  inject: ["localAccess", "persistence"],
  apply(ctx) {
    ctx.register("designReview", () =>
      createDesignReviewService({
        repository: createDesignReviewRepository(ctx.get("persistence")),
      }),
    );
  },
  mounted(ctx) {
    void registerDesignReviewRoutes(ctx.app, {
      localAccess: ctx.get("localAccess"),
      designReviewService: ctx.get("designReview"),
    });
  },
};
