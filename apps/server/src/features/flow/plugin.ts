import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { PluginDefinition } from "../../kernel/types.js";

/**
 * flow-host 插件：宿主适配层的宿主侧端点（`/api/flow/host/*`，`ff-embed/v1`）。
 *
 * 能力缝三元组：
 * - Service Definition：`ff-embed/v1` 契约（`packages/shared/src/flow-host.ts`）
 * - Service Provider：本插件注册的宿主侧路由（身份交换；凭证 / 计费 / 事件随 P3–P5 接上）
 * - Consumer：flow 网关的 embedded Provider（`flow/gateway/src/host/embedded-*.provider.ts`）
 *
 * 与 `plugins/flow` 的分工（FORM-11）：**这里**是基础设施（flow 网关回调宿主），
 * **插件**是产品入口（工作台 Flow 模式 + 引擎托管）。没配共享密钥时插件不注册任何路由
 * ——本实例就是「不提供 flow 宿主能力」，而不是半残。
 */
export function createFlowHostPlugin(deps: {
  /** `KENFUTWORK_FLOW_EMBED_SECRET`；缺省表示未启用。 */
  secret?: string | undefined;
}): PluginDefinition {
  return {
    name: "flow-host",
    inject: ["auth", "viewer"],
    apply(ctx) {
      const secret = deps.secret?.trim();
      if (!secret) {
        console.log(
          "[flow] 未配置 KENFUTWORK_FLOW_EMBED_SECRET：flow 宿主身份交换端点不启用。",
        );
        return;
      }
      ctx.effect(() => () => {
        // 路由由 Fastify 生命周期回收，这里只留一条可追溯日志（便于排查「明明配了却没生效」）。
        console.log("[flow] flow 宿主身份交换端点已停用。");
      });
    },
    mounted(ctx) {
      const secret = deps.secret?.trim();
      if (!secret) return;
      void registerFlowHostRoutes(ctx.app, {
        auth: ctx.get("auth"),
        viewer: ctx.get("viewer"),
        secret,
      });
    },
  };
}
