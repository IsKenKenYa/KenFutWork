import { registerOpenDesignHostRoutes } from "../../http/open-design-host.js";
import type { PluginDefinition } from "../../kernel/types.js";

/**
 * OpenDesign 宿主适配层插件。
 *
 * 与 `plugins/open-design` 的分工（同 flow 的 FORM-11 口径）：
 * - **这里**是基础设施：把 `/api/open-design/host/*` 挂到宿主，回答「面板该不该出现」；
 * - **插件**是产品入口：安装态决定 Code 模式右侧栏是否出现 OpenDesign 面板。
 *
 * 路由**始终注册**：status 是能力探针，未配齐也要如实回答 disabled 与缺失原因
 * （不假装能用）；前端据此不摆空壳、不放假开关。
 *
 * 本期只做探活缝（O0/O1）。iframe 内嵌与双向链接、BYOK 凭证下发按《OpenDesign 集成规划》
 * 的 O2/O3 另立提交。
 */
export function createOpenDesignHostPlugin(deps: {
  /** `KENFUTWORK_OPEN_DESIGN_FRONTEND_URL`；缺省表示未启用。 */
  frontendUrl?: string | undefined;
  /** 探活用 fetch（测试注入，避免真发网络请求）。 */
  fetchImpl?: typeof fetch | undefined;
}): PluginDefinition {
  return {
    name: "open-design-host",
    inject: ["localAccess"],
    apply() {
      if (!deps.frontendUrl?.trim()) {
        // 不视为错误：status 端点会如实回答 disabled + 缺什么，前端不摆空壳入口。
        console.log(
          "[open-design] 未配置 OpenDesign 前端地址（KENFUTWORK_OPEN_DESIGN_FRONTEND_URL）：" +
            "Code 模式右侧栏不出现 OpenDesign 面板（GET /api/open-design/host/status 可查原因）。",
        );
      }
    },
    mounted(ctx) {
      void registerOpenDesignHostRoutes(ctx.app, {
        localAccess: ctx.get("localAccess"),
        frontendUrl: deps.frontendUrl,
        fetchImpl: deps.fetchImpl,
      });
    },
  };
}
