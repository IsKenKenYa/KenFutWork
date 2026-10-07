import { registerJobRoutes } from "../../http/jobs.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { JobService } from "./job-service.js";
import { createJobService } from "./job-service.js";
import { createJobRepository } from "./repository.js";

/**
 * jobs 插件：PGMQ 任务服务 + 任务路由。
 * enabled 判定（§4.2「enabled: 有 databaseUrl」）：无数据库连接且无注入实例时不装配，
 * 消费方（generate/agent-runs）经 ctx.tryGet("jobs") 可选解析。
 * 注入 injected（原 BuildAppOptions.jobService）时无条件启用，保持历史行为。
 */
export function createJobsPlugin(
  deps: {
    injected?: JobService | undefined;
    /** HTTP 进程挂路由（需本机接入）；worker 传 false。 */
    withRoutes?: boolean;
  } = {},
): PluginDefinition {
  const isEnabled = (hasDatabaseUrl: boolean): boolean =>
    Boolean(deps.injected || hasDatabaseUrl);
  const withRoutes = deps.withRoutes ?? true;
  return {
    name: "jobs",
    // worker 只走「按 id 迁移状态」路径（无用户身份、无 本机接入），
    // 接入路径缺 localInstance 时由服务 fail loud。
    inject: withRoutes
      ? [
          "localAccess",
          "persistence",
          "queue",
          "localInstance",
          "modelProviders",
        ]
      : ["persistence", "queue"],
    enabled: (env) => isEnabled(Boolean(env.databaseUrl)),
    apply(ctx) {
      const localInstance = ctx.tryGet("localInstance");
      ctx.register("jobs", () => {
        return createJobService({
          queue: ctx.get("queue"),
          repository: createJobRepository(ctx.get("persistence")),
          ...(localInstance ? { localInstance } : {}),
        });
      });
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      const jobService = ctx.get("jobs");
      void registerJobRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        jobService,
        localInstance: ctx.get("localInstance"),
        modelProviders: ctx.get("modelProviders"),
      });
    },
  };
}
