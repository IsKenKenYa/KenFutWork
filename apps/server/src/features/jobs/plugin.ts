import { registerJobRoutes } from "../../http/jobs.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createPgmqClient } from "../../queue/pgmq-client.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import type { JobService } from "./job-service.js";
import { createJobService } from "./job-service.js";

/**
 * jobs 插件：PGMQ 任务服务 + 任务路由。
 * enabled 判定（§4.2「enabled: 有 databaseUrl」）：无数据库连接且无注入实例时不装配，
 * 消费方（generate/agent-runs）经 ctx.tryGet("jobs") 可选解析。
 * 注入 injected（原 BuildAppOptions.jobService）时无条件启用，保持历史行为。
 */
export function createJobsPlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
  injected?: JobService | undefined;
  /** HTTP 进程挂路由（需 auth/credits/tierGuard/viewer）；worker 传 false。 */
  withRoutes?: boolean;
}): PluginDefinition {
  const isEnabled = (hasDatabaseUrl: boolean): boolean =>
    Boolean(deps.injected || hasDatabaseUrl);
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "jobs",
    inject: withRoutes ? ["auth", "credits", "tierGuard", "viewer"] : [],
    enabled: (env) => isEnabled(Boolean(env.databaseUrl)),
    apply(ctx) {
      ctx.register("jobs", () => {
        // enabled 已保证无注入实例时必有 databaseUrl；有注入实例时 override 优先，工厂不会执行。
        const pgmq = createPgmqClient(ctx.env.databaseUrl as string);
        return createJobService({
          createUserClient: deps.createUserClient,
          getAdminClient: deps.getAdminClient,
          pgmq,
        });
      });
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      const jobService = ctx.get("jobs");
      void registerJobRoutes(ctx.app, {
        auth: ctx.get("auth"),
        creditService: ctx.get("credits"),
        jobService,
        tierGuard: ctx.get("tierGuard"),
        viewerService: ctx.get("viewer"),
      });
    },
  };
}
