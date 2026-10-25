import { registerUsageRoutes } from "../../http/usage.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { CODE_UI_HOST_RPC_CAPABILITY } from "../code-ui/host-rpc-handler.js";
import { createCodeUiUsageHost } from "./code-ui-host.js";
import { createUsageRepository } from "./repository.js";
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
export function createUsagePlugin(
  deps: {
    /** HTTP 进程挂路由（需 auth）；worker 传 false。 */
    withRoutes?: boolean;
  } = {},
): PluginDefinition {
  const withRoutes = deps.withRoutes ?? true;
  // apply 期构造、mounted 期复用（同一实例；与 skills 插件同款模式）
  let usageRepository: ReturnType<typeof createUsageRepository> | undefined;
  return {
    name: "usage",
    // 两个进程共享稳定实例归属；只有 HTTP 进程消费接入验证。
    inject: withRoutes
      ? ["localAccess", "persistence", "localInstance"]
      : ["persistence", "localInstance"],
    apply(ctx) {
      const persistence = ctx.get("persistence");
      usageRepository = createUsageRepository(persistence);
      const usageService = createUsageService({
        repository: usageRepository,
        localInstance: ctx.get("localInstance"),
      });
      ctx.register("usage", () => usageService);
      const accumulator: RunUsageAccumulator = createRunUsageAccumulator();
      ctx.register("runUsage", () => accumulator);

      // 事件缝职责：归属 + 收尾结算（DEC-1 turn-stopping）
      ctx.on("turn-stopping", async (payload, next) => {
        for (const entry of accumulator.take(payload.runId)) {
          await usageService.record({
            instanceId: entry.instanceId,
            ...(entry.accessClientId
              ? { accessClientId: entry.accessClientId }
              : {}),
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
            ...(entry.costUsd != null ? { costUsd: entry.costUsd } : {}),
          });
        }
        await next();
      });
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      void registerUsageRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        usage: ctx.get("usage"),
      });
      // code-ui「使用统计」面板的数据宿主（替换此前的 501 兜底）
      if (usageRepository) {
        const repository = usageRepository;
        for (const [id, value] of Object.entries(
          createCodeUiUsageHost({
            localInstance: ctx.get("localInstance"),
            repository,
          }),
        )) {
          ctx.effect(() =>
            ctx
              .get("capabilities")
              .register(CODE_UI_HOST_RPC_CAPABILITY, { id, value }),
          );
        }
      }
    },
  };
}
