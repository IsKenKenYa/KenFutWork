import { registerPermissionRoutes } from "../../http/permissions.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import {
  createPermissionService,
  type PermissionService,
} from "./permission-service.js";

/**
 * permissions 插件（DEC-4，P6）：
 * - `permissions` ctx key：三档策略 + 审批记忆；
 * - 订阅 tool-pre-execute 事件做拦截（deny 等 审批），这是策略缝的消费点；
 * - design preset 不激活闸门（保持画布行为不变）：本插件只拦截代码类工具，
 *   画布工具（design scope）不触发审批（isDangerousTool 不匹配）。
 */
export function createPermissionsPlugin(deps: {
  events?: KernelEvents;
}): PluginDefinition {
  return {
    name: "permissions",
    inject: ["auth"],
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
      void registerPermissionRoutes(ctx.app, {
        auth: ctx.get("auth"),
        permissions: ctx.get("permissions"),
      });
    },
  };
}
