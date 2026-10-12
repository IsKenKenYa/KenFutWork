import { registerPermissionRoutes } from "../../http/permissions.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import {
  createPermissionService,
  type PermissionService,
} from "./permission-service.js";
import { createPermissionSettingsStore } from "./tier-store.js";

/**
 * permissions 插件（DEC-4，P6）：
 * - `permissions` ctx key：三档策略 + 审批记忆；
 * - 订阅 tool-pre-execute 事件做拦截（deny 等 审批），这是策略缝的消费点；
 * - Kernel 工具在 `tool-pre-execute` 中按 payload 路径处理：有 `permissionInvocation` 时调用
 *   `service.admit`，否则按工具名与属主声明的效果调用 `service.evaluate`。
 * - DeepAgents 原生工具不经过此事件，由 `agent/tool-gate.ts` 的 permission verdict 控制。
 */
export function createPermissionsPlugin(_deps: {
  events?: KernelEvents;
}): PluginDefinition {
  return {
    name: "permissions",
    inject: ["localAccess", "persistence"],
    apply(ctx) {
      const service: PermissionService = createPermissionService();
      ctx.register("permissions", () => service);

      // Code 在此等待真实人审；所有 waterfall 消费方放行后才由 kernel claim。
      ctx.on("tool-pre-execute", async (payload, next) => {
        if (payload.decision === "deny") return next(payload);
        const decision = payload.permissionInvocation
          ? await service.admit(payload.permissionInvocation)
          : service.evaluate({
              toolName: payload.toolName,
              ...(payload.threadId ? { threadId: payload.threadId } : {}),
              // 属主声明的效果随事件带来：插件写工具靠它进默认档审批（名表不认识它们）。
              ...(payload.access ? { access: payload.access } : {}),
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
      const tierStore = createPermissionSettingsStore(ctx.get("persistence"));
      void tierStore
        .load()
        .then((settings) => {
          service.applySettings(settings);
          console.log(
            `[permissions] 已读回持久化权限设置：常规=${settings.tier} 自动化=${settings.automationTier}` +
              ` 自定义规则=${settings.rules.allow.length}+${settings.rules.deny.length}` +
              ` 浏览器控制=${settings.browserControlEnabled ? "on" : "off"}`,
          );
        })
        .catch((error: unknown) => {
          console.warn(
            "[permissions] 权限设置读回失败（使用默认 default）：",
            error instanceof Error ? error.message : String(error),
          );
        });
      void registerPermissionRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        permissions: service,
        tierStore,
      });
    },
  };
}
