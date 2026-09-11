import { registerUsageRoutes } from "../../http/usage.js";
import type { PluginDefinition } from "../../kernel/types.js";
import type { AdminSupabaseClient } from "../../supabase/admin.js";
import type { UserSupabaseClient } from "../../supabase/user.js";
import {
  createRunUsageAccumulator,
  type RunUsageAccumulator,
} from "./run-usage-accumulator.js";
import { createUsageService } from "./usage-service.js";

/**
 * usage 插件（DEC-6，P4c）：
 * - `usage` ctx key：用量落账/汇总服务；
 * - run 用量累积器：stream-adapter 采集点写这里（采集不经事件缝，§4.5）；
 * - `turn-stopping` 事件监听器：把累积用量归属到 run 并收尾结算（事件缝的唯一职责）；
 * - 直连生成链路由 executor 在 job 完成回调处直接落账，两处同表，不留盲区。
 */
export function createUsagePlugin(deps: {
  createUserClient: (accessToken: string) => UserSupabaseClient;
  getAdminClient: () => AdminSupabaseClient;
}): PluginDefinition {
  return {
    name: "usage",
    inject: ["auth"],
    apply(ctx) {
      const usageService = createUsageService({
        createUserClient: deps.createUserClient,
        getAdminClient: deps.getAdminClient,
      });
      ctx.register("usage", () => usageService);
      const accumulator: RunUsageAccumulator = createRunUsageAccumulator();
      ctx.register("runUsage", () => accumulator);

      // 事件缝职责：归属 + 收尾结算（DEC-1 turn-stopping）
      ctx.on("turn-stopping", async (payload, next) => {
        const entry = accumulator.take(payload.runId);
        if (entry) {
          const workspaceId = await usageService.resolveWorkspaceIdByUser(
            entry.userId,
          );
          if (!workspaceId) return;
          await usageService.record({
            workspaceId,
            provider: entry.provider,
            model: entry.model,
            capability: "chat",
            ...(entry.providerInstanceId
              ? { providerInstanceId: entry.providerInstanceId }
              : {}),
            runId: payload.runId,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.inputTokens + entry.outputTokens,
          });
        }
        await next();
      });
    },
    mounted(ctx) {
      void registerUsageRoutes(ctx.app, {
        auth: ctx.get("auth"),
        usage: ctx.get("usage"),
      });
    },
  };
}
