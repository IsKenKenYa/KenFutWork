import { registerPermissionRoutes } from "../../http/permissions.js";
import type { KernelEvents, PluginDefinition } from "../../kernel/types.js";
import type { ApprovalReviewer } from "./approval-types.js";
import { createPermissionAuditStore } from "./audit-store.js";
import {
  createPermissionService,
  type PermissionService,
} from "./permission-service.js";
import type { PermissionSettings } from "./tier-store.js";
import { createPermissionSettingsStore } from "./tier-store.js";

/**
 * permissions 插件（DEC-4，P6）：
 * - `permissions` ctx key：三档策略 + 审批记忆；
 * - 订阅 tool-pre-execute 事件做拦截（deny 等 审批），这是策略缝的消费点；
 * - Kernel 工具在 `tool-pre-execute` 中按 payload 路径处理：有 `permissionInvocation` 时调用
 *   `service.admit`，否则按工具名与属主声明的效果调用 `service.evaluate`。
 * - DeepAgents 原生工具不经过此事件，由 agent-runs 的工具权限检查控制。
 */
/**
 * AI 安全防护的「审批模型审查」是否开启。
 *
 * 与 WorkBuddy 同口径：**整组默认关闭**。旧数据里字段缺席时 `permissionPolicySchema`
 * 的缺省值补成 `false`，行为与「未开启」一致，需要自动审阅的用户在权限页显式打开。
 */
export function approvalReviewEnabled(settings: PermissionSettings): boolean {
  return settings.policy.aiSafety.approvalReview === true;
}

export function createPermissionsPlugin(_deps: {
  events?: KernelEvents;
}): PluginDefinition {
  return {
    name: "permissions",
    inject: ["localAccess", "persistence", "approvalReview"],
    apply(ctx) {
      /**
       * AI 安全防护（模型行为智能审查 + AI 智能审批）的裁决点。
       *
       * 开关打开时交给审批模型（`approvalReview`）：常规且有界的自动放行，可疑的
       * 交回人工。关掉后一律返回 `manual`——不经模型，人自己看。
       */
      const reviewIfEnabled: ApprovalReviewer = (input, signal) =>
        approvalReviewEnabled(service.getSettings())
          ? ctx.get("approvalReview").review(input, signal)
          : Promise.resolve("manual");
      // 先声明再赋值：上面的闭包要读 `service` 自己的设置（惰性调用，赋值已完成）。
      let service: PermissionService;
      service = createPermissionService({ review: reviewIfEnabled });
      ctx.register("permissions", () => service);

      // Code 在此等待真实人审；所有 waterfall 消费方放行后才由 kernel claim。
      ctx.on("tool-pre-execute", async (payload, next) => {
        if (payload.decision === "deny") return next(payload);
        // 工具策略（禁用清单 / 三态「拒绝」/ 路径与命令规则）先于一切：
        // 命中禁用或「拒绝」即硬拒绝，不给审批机会；命中「允许」直接放行。
        const policy = service.checkToolPolicy(payload.toolName, payload.args);
        if (policy?.blocked) {
          return next({
            ...payload,
            decision: "deny",
            denyReason: policy.reason,
          });
        }
        if (policy?.decision === "allow") {
          return next({ ...payload, decision: "allow" });
        }
        // 「询问」落在这里：继续走审批链路，让人来点（策略本身不替人做决定）。
        const decision = payload.permissionInvocation
          ? await service.admit(payload.permissionInvocation)
          : service.evaluate({
              toolName: payload.toolName,
              scenario: payload.goalId ? "automation" : "interactive",
              ...(payload.threadId ? { threadId: payload.threadId } : {}),
              // 属主声明的效果随事件带来：插件写工具靠它进默认档审批（名表不认识它们）。
              ...(payload.access ? { access: payload.access } : {}),
              // 路径/命令规则要按这次实际操作的路径与命令判。
              args: payload.args,
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
      const auditStore = createPermissionAuditStore(ctx.get("persistence"));
      // 审计流水接在 service 的判定旁路：只记结论与命中的规则，不记工具参数。
      service.setAuditSink((record) => {
        void auditStore.record(record).catch(() => {
          // 流水写失败不影响判定；这里只吞掉，避免未处理的 rejection 打断进程
        });
      });
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
        auditStore,
      });
    },
  };
}
