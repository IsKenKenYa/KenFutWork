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

const METASO_ENDPOINT = "https://api.metaso.cc/v1/search";

/** 防御式解析：兼容 results / searchResultList 两种返回形状。 */
export function parseSearchResponse(payload: unknown): WebSearchResult[] {
  const record = (payload ?? {}) as {
    results?: unknown;
    searchResultList?: unknown;
  };
  const raw =
    (Array.isArray(record.results) && record.results) ||
    (Array.isArray(record.searchResultList) && record.searchResultList) ||
    [];
  return raw
    .map((item) => {
      const r = item as { title?: unknown; link?: unknown; content?: unknown };
      return {
        title: String(r.title ?? ""),
        link: String(r.link ?? ""),
        content: String(r.content ?? ""),
      };
    })
    .filter((r) => r.link);
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
      const num = Math.min(Math.max(Number(args.num ?? 8) || 8, 1), 20);
      const endpoint =
        deps.config.endpoint ??
        (deps.config.provider === "metaso" ? METASO_ENDPOINT : "");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.config.apiKey}`,
        },
        body: JSON.stringify({ q: query, num }),
      });
      if (!response.ok) {
        throw new Error(
          `web_search 请求失败（${response.status}），请检查搜索供应商配置。`,
        );
      }
      const results = parseSearchResponse(await response.json());
      return { query, results };
    },
  };
}
