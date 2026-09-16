import { computeChatCreditCost } from "@kenfutwork/shared";

import { registerUsageRoutes } from "../../http/usage.js";
import type { PluginContext, PluginDefinition } from "../../kernel/types.js";
import { createViewerRepository } from "../bootstrap/repository.js";
import { createUsageRepository } from "./repository.js";
import {
  createRunUsageAccumulator,
  type RunUsageAccumulator,
  type RunUsageEntry,
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
  return {
    name: "usage",
    // worker 进程无 auth（与无 viewer 同因），故 persistence 是两侧共同依赖。
    inject: withRoutes ? ["auth", "persistence"] : ["persistence"],
    apply(ctx) {
      const persistence = ctx.get("persistence");
      const usageService = createUsageService({
        repository: createUsageRepository(persistence),
        workspaces: createViewerRepository(persistence),
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
            userId: entry.userId,
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

          // 平台池计费（FORM-10）：只有走系统供应商（scope='system'）的运行
          // 才扣额度——用户自带 Key（BYOK）不计费。计量失败不阻断主链路。
          await chargePlatformPoolUsage(ctx, entry, workspaceId, payload.runId);
        }
        await next();
      });
    },
    mounted(ctx) {
      if (!withRoutes) {
        return;
      }
      void registerUsageRoutes(ctx.app, {
        auth: ctx.get("auth"),
        usage: ctx.get("usage"),
      });
    },
  };
}

/**
 * 平台池运行的费用结算：按 token 折算 credit 扣额度。
 *
 * 依赖用 tryGet 取（worker profile 无 credits/modelProviders，读到就跳过），
 * 任何失败只记警告——额度结算是旁路，不能反过来打断用户对话。
 */
async function chargePlatformPoolUsage(
  ctx: PluginContext,
  entry: RunUsageEntry,
  workspaceId: string,
  runId: string,
): Promise<void> {
  if (!entry.providerInstanceId) return;
  const modelProviders = ctx.tryGet("modelProviders");
  const credits = ctx.tryGet("credits");
  if (!modelProviders || !credits) return;
  try {
    const scope = await modelProviders.getInstanceScope(
      entry.providerInstanceId,
    );
    if (scope !== "system") return;
    const totalTokens = entry.inputTokens + entry.outputTokens;
    const cost = computeChatCreditCost(totalTokens);
    await credits.deductChatCredits(
      workspaceId,
      entry.userId,
      cost,
      runId,
      `平台池对话 ${totalTokens} tokens`,
    );
  } catch (error) {
    console.warn("[usage] platform pool charging failed:", error);
  }
}
