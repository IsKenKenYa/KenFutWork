import type { PluginDefinition } from "../../kernel/types.js";
import { createPostgresPersistence } from "./providers/postgres.js";

/**
 * persistence 插件（去 Supabase 存储缝，M1）：自管 Postgres Provider。
 *
 * 启用条件 = 配置了 `databaseUrl`（fail loud：未配置则不挂载，声明了
 * `inject: ["persistence"]` 的消费方在启动期立即报错，不静默降级）。
 */
export const persistencePlugin: PluginDefinition = {
  name: "persistence",
  inject: [],
  enabled: (env) => Boolean(env.databaseUrl),
  apply(ctx) {
    ctx.register("persistence", () => {
      const databaseUrl = ctx.env.databaseUrl;
      if (!databaseUrl) {
        throw new Error(
          "[persistence] 缺少数据库连接串（KENFUTWORK_DATABASE_URL / DATABASE_URL）——自管 Postgres Provider 无法建立连接池。",
        );
      }
      return createPostgresPersistence({ databaseUrl });
    });

    // 退出必须等待真实连接池释放；失败保持可见并由内核保留disposer以便重试。
    ctx.effect(() => async () => {
      await ctx.tryGet("persistence")?.close();
    });
  },
};
