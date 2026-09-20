import type { PluginDefinition } from "../../kernel/types.js";
import {
  createWebChannelSearchTool,
  createWebSearchTool,
} from "./web-search.js";

/**
 * 联网搜索插件（§4.5，BYOK 搜索供应商）。
 *
 * **两条实现，按有没有 Key 分**（两边都贡献同名 `web_search`，模型侧用法一致）：
 * - 配了 `KENFUTWORK_SEARCH_API_KEY`（供应商由 `KENFUTWORK_SEARCH_PROVIDER` 指定，v1 metaso）
 *   → 走**结构化结果 API**（标题 / 链接 / 摘要）；
 * - 没配 → 走**网页通道**：抓一次搜索引擎结果页、从链接还原结果列表。它只用只读抓取
 *   （与 `browser_open` 同一个 `fetchPageSnapshot`），因此**不受「允许 AI 控制浏览器」开关门控**。
 *
 * 为什么不再用 `enabled` 判掉整个插件：文档口径是「这一段可以整块不配；不配也能搜（走网页
 * 通道）」，但此前唯一的执行面 `browser_open` 默认关着——开箱状态下实际是**搜不了**
 * （2026-09-20 真机走查实测：`web_search` 不装配 + `browser_open` 被拒，模型只能 curl 兜底）。
 * 插件因此常驻，由 `apply` 内部二选一。
 *
 * `KENFUTWORK_SEARCH_ENDPOINT` 覆盖默认端点（镜像/代理/联调）；
 * `KENFUTWORK_SEARCH_ENGINE`（bing|baidu）选网页通道用哪个引擎。
 */
export function createSearchPlugin(): PluginDefinition {
  return {
    name: "search",
    // 网页通道要借浏览器缝的只读抓取（同一个 fetchPageSnapshot：同时限、同上限、同拦截）
    inject: ["browser"],
    apply(ctx) {
      const apiKey = ctx.env.searchApiKey;
      if (!apiKey) {
        const engine =
          ctx.env.searchEngine === "baidu" || ctx.env.searchEngine === "bing"
            ? ctx.env.searchEngine
            : undefined;
        ctx.get("tools").register(
          createWebChannelSearchTool({
            snapshot: (url, options) =>
              ctx.get("browser").snapshot(url, options),
            ...(engine ? { engine } : {}),
          }),
        );
        return;
      }
      const provider = ctx.env.searchProvider ?? "metaso";
      ctx.get("tools").register(
        createWebSearchTool({
          config: {
            provider,
            apiKey,
            ...(ctx.env.searchEndpoint
              ? { endpoint: ctx.env.searchEndpoint }
              : {}),
          },
        }),
      );
    },
  };
}
