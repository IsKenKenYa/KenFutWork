import type { ToolDefinition } from "../../kernel/types.js";

/**
 * 联网搜索工具（§4.5 基础能力层，BYOK 搜索供应商）。
 * v1 供应商封闭集合：metaso（POST JSON API）；HTTP 用 undici 全局 fetch（§4.11）。
 * 测试经 fetchImpl 注入，不发真实网络请求。
 */

export interface WebSearchResult {
  title: string;
  link: string;
  content: string;
}

export interface WebSearchProviderConfig {
  provider: "metaso";
  apiKey: string;
  /** 覆盖默认 API 端点（测试/代理）。 */
  endpoint?: string;
}

export type FetchImpl = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * 秘塔搜索端点（2026-09-14 校正）：官方文档为 `metaso.cn/api/v1/search`。
 * 旧值 `api.metaso.cc/v1/search` 是**不存在的主机**（DNS 不解析，请求恒失败）。
 */
const METASO_ENDPOINT = "https://metaso.cn/api/v1/search";

/**
 * 防御式解析：真实返回键是 `webpages`（字段 title/link/snippet）；
 * 兼容 `results` / `searchResultList` 两种别名形状，减少上游改版带来的硬崩。
 */
export function parseSearchResponse(payload: unknown): WebSearchResult[] {
  const record = (payload ?? {}) as {
    webpages?: unknown;
    results?: unknown;
    searchResultList?: unknown;
  };
  const raw =
    (Array.isArray(record.webpages) && record.webpages) ||
    (Array.isArray(record.results) && record.results) ||
    (Array.isArray(record.searchResultList) && record.searchResultList) ||
    [];
  return raw
    .map((item) => {
      const r = item as {
        title?: unknown;
        link?: unknown;
        url?: unknown;
        snippet?: unknown;
        content?: unknown;
        summary?: unknown;
      };
      return {
        title: String(r.title ?? ""),
        link: String(r.link ?? r.url ?? ""),
        content: String(r.snippet ?? r.content ?? r.summary ?? ""),
      };
    })
    .filter((r) => r.link);
}

/**
 * 秘塔**用 HTTP 200 承载业务错误**（错误体形如 `{ errCode: 2005, errMsg: "API密钥无效" }`）。
 * 只看 `response.ok` 会把「Key 无效」当成「搜到 0 条」静默吞掉，故单独提取。
 */
export function parseSearchError(payload: unknown): string | undefined {
  const record = (payload ?? {}) as { errCode?: unknown; errMsg?: unknown };
  const code = Number(record.errCode ?? 0);
  if (!code) return undefined;
  const message = String(record.errMsg ?? "").trim();
  return message || `上游错误码 ${code}`;
}

export function createWebSearchTool(deps: {
  config: WebSearchProviderConfig;
  fetchImpl?: FetchImpl;
}): ToolDefinition {
  const fetchImpl: FetchImpl =
    deps.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    name: "web_search",
    description:
      "联网搜索：按查询词检索公开网页，返回标题/链接/摘要列表。需要实时信息时使用。",
    scope: "shared",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询词" },
        num: {
          type: "number",
          description: "返回条数（1-20，默认 8）",
        },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) {
        throw new Error("web_search 需要 query 参数");
      }
      const num = Math.min(Math.max(Math.floor(Number(args.num ?? 8)) || 8, 1), 20);
      const endpoint =
        deps.config.endpoint ??
        (deps.config.provider === "metaso" ? METASO_ENDPOINT : "");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.config.apiKey}`,
        },
        // 秘塔只认 `q`/`scope`/`size`/`page`；旧代码发的 `num` 被上游忽略，条数恒为默认值
        body: JSON.stringify({
          q: query,
          scope: "webpage",
          size: String(num),
          page: "1",
        }),
      });
      if (!response.ok) {
        throw new Error(
          `web_search 请求失败（${response.status}），请检查搜索供应商配置。`,
        );
      }
      const payload = await response.json();
      const upstreamError = parseSearchError(payload);
      if (upstreamError) {
        throw new Error(
          `web_search 请求失败（${upstreamError}），请检查搜索供应商配置。`,
        );
      }
      const results = parseSearchResponse(payload);
      return { query, results };
    },
  };
}
