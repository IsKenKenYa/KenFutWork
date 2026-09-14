import { registerPermissionRoutes } from "../../http/permissions.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import {
  createPermissionService,
  type PermissionService,
} from "./permission-service.js";
import { createPermissionTierStore } from "./tier-store.js";

/**
 * permissions 插件（DEC-4，P6）：
 * - `permissions` ctx key：三档策略 + 审批记忆；
 * - 订阅 tool-pre-execute 事件做拦截（deny 等 审批），这是策略缝的消费点；
 * - design preset 不激活闸门（保持画布行为不变）：本插件只拦截代码类工具，
 *   画布工具（design scope）不触发审批（isDangerousTool 不匹配）。
 *
 * 全局档位持久化（app_config 单行表）：启动期读回（读失败只记日志，回落 default
 * ——fail-safe：权限档宁严勿松），PUT 路由写穿。
 */
export function createPermissionsPlugin(deps: {
  events?: KernelEvents;
}): PluginDefinition {
  return {
    name: "permissions",
    inject: ["auth", "persistence"],
    apply(ctx) {
      const service: PermissionService = createPermissionService();
      ctx.register("permissions", () => service);

      // tool-pre-execute 拦截（waterfall）：deny 即阻止工具执行
      ctx.on("tool-pre-execute", async (payload, next) => {
        const decision = service.evaluate({
          toolName: payload.toolName,
        });
        return next({
          ...payload,
          ...(decision.decision === "deny"
            ? { decision: "deny", denyReason: decision.reason }
            : {}),
        });
      });
    },
    mounted(ctx) {
      const service = ctx.get("permissions");
      const tierStore = createPermissionTierStore(ctx.get("persistence"));
      void tierStore
        .load()
        .then((tier) => {
          if (tier) {
            service.setTier(undefined, tier);
            console.log(`[permissions] 已读回持久化权限档位：${tier}`);
          }
        })
        .catch((error: unknown) => {
          console.warn(
            "[permissions] 权限档位读回失败（使用默认 default）：",
            error instanceof Error ? error.message : String(error),
          );
        });
      void registerPermissionRoutes(ctx.app, {
        auth: ctx.get("auth"),
        permissions: service,
        tierStore,
      });
    },
  };
}
