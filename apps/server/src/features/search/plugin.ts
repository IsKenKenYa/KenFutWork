import type { ServerEnv } from "../../config/env.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createWebSearchTool } from "./web-search.js";

/**
 * 联网搜索插件（§4.5，BYOK 搜索供应商）：
 * 配置 `KENFUTWORK_SEARCH_API_KEY`（供应商由 `KENFUTWORK_SEARCH_PROVIDER` 指定，v1 metaso）
 * 即向 `ctx.tools` 贡献 `web_search`（shared scope）；未配置则不装配（enabled 判定）。
 * `KENFUTWORK_SEARCH_ENDPOINT` 可覆盖默认端点（镜像/代理/联调）。
 */
export function createSearchPlugin(): PluginDefinition {
  return {
    name: "search",
    inject: [],
    enabled: (env: ServerEnv) => Boolean(env.searchApiKey),
    apply(ctx) {
      const provider = ctx.env.searchProvider ?? "metaso";
      ctx.get("tools").register(
        createWebSearchTool({
          config: {
            provider,
            apiKey: ctx.env.searchApiKey as string,
            ...(ctx.env.searchEndpoint
              ? { endpoint: ctx.env.searchEndpoint }
              : {}),
          },
        }),
      );
    },
  };
}
