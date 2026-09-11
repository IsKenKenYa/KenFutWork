import { registerSkillRoutes } from "../../http/skills.js";
import { registerMarketplaceRoutes } from "../../http/skills-marketplace.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { UserSupabaseClient } from "../../supabase/user.js";

/**
 * skills 插件：技能导入 + 技能市场路由（服务在路由层经 createUserClient 内聚构造）。
 * P5 将把 skill 发现收敛为 ctx.tools 工具缝；本插件只承载 HTTP 面。
 */
export function createSkillsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
}): PluginDefinition {
  return {
    name: "skills",
    inject: ["auth", "viewer"],
    apply() {},
    mounted(ctx) {
      void registerSkillRoutes(ctx.app, {
        auth: ctx.get("auth"),
        createUserClient: deps.createUserClient,
        viewerService: ctx.get("viewer"),
      });
      void registerMarketplaceRoutes(ctx.app, {
        auth: ctx.get("auth"),
        createUserClient: deps.createUserClient,
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
