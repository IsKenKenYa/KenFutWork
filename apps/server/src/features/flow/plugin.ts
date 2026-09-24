import { registerFlowHostRoutes } from "../../http/flow-host.js";
import type { PluginDefinition } from "../../kernel/types.js";

/**
 * flow-host 插件：宿主适配层的宿主侧端点（`/api/flow/host/*`，`ff-embed/v1`）。
 *
 * 能力缝三元组：
 * - Service Definition：`ff-embed/v1` 契约（`packages/shared/src/flow-host.ts`）
 * - Service Provider：本插件注册的宿主侧路由（身份交换 + 凭证下发；计费 / 事件随 P4–P5 接上）
 * - Consumer：flow 网关的 embedded Provider（`flow/gateway/src/host/embedded-*.provider.ts`）
 *
 * 与 `plugins/flow` 的分工（FORM-11）：**这里**是基础设施（flow 网关回调宿主），
 * **插件**是产品入口（工作台 Flow 模式 + 引擎托管）。路由始终注册：status 是能力探针，
 * 未配齐也要如实回答 disabled 与缺失原因；身份/凭证交换在未配密钥时按请求回 503（不假装能用）。
 */
export function createFlowHostPlugin(deps: {
  /** `KENFUTWORK_FLOW_EMBED_SECRET`；缺省表示未启用。 */
  secret?: string | undefined;
  /** `KENFUTWORK_FLOW_FRONTEND_URL`；工作台 Flow 模式的 iframe src。 */
  frontendUrl?: string | undefined;
}): PluginDefinition {
  return {
    name: "flow-host",
    inject: ["auth", "viewer", "modelProviders"],
    apply(ctx) {
      if (!deps.secret?.trim() || !deps.frontendUrl?.trim()) {
        // 不视为错误：status 端点会如实回答 disabled + 缺什么，前端不摆空壳入口。
        console.log(
          "[flow] flow 宿主适配层未配齐（KENFUTWORK_FLOW_EMBED_SECRET / KENFUTWORK_FLOW_FRONTEND_URL）：" +
            "身份交换不可用，工作台不出现 Flow 模式入口（GET /api/flow/host/status 可查原因）。",
        );
      }
      ctx.effect(() => () => {
        // 路由由 Fastify 生命周期回收，这里只留一条可追溯日志（便于排查「明明配了却没生效」）。
        console.log("[flow] flow 宿主适配层路由已停用。");
      });
    },
    mounted(ctx) {
      void registerFlowHostRoutes(ctx.app, {
        auth: ctx.get("auth"),
        viewer: ctx.get("viewer"),
        providers: ctx.get("modelProviders"),
        secret: deps.secret,
        frontendUrl: deps.frontendUrl,
      });
    },
  };
}
