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

/**
 * 面向用户的工具错误。
 *
 * 这些文案本身就能直接展示（「请检查搜索供应商配置」是可执行的下一步），而通用
 * sanitizer 会把未知错误压成「请求处理失败，请重试。」——用户既看不到原因、也
 * 不知道去哪儿改。标记 `exposeToClient` 后 sanitizer 原样透传（见 utils/error-sanitizer）。
 */
export class WebSearchError extends Error {
  readonly exposeToClient = true;

  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
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
    exposure: "deferred",
    access: "read",
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
        throw new WebSearchError("web_search 需要 query 参数");
      }
      const num = Math.min(
        Math.max(Math.floor(Number(args.num ?? 8)) || 8, 1),
        20,
      );
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
        throw new WebSearchError(
          `web_search 请求失败（${response.status}），请检查搜索供应商配置。`,
        );
      }
      const payload = await response.json();
      const upstreamError = parseSearchError(payload);
      if (upstreamError) {
        throw new WebSearchError(
          `web_search 请求失败（${upstreamError}），请检查搜索供应商配置。`,
        );
      }
      const results = parseSearchResponse(payload);
      return { query, results };
    },
  };
}

/**
 * 不配搜索供应商 Key 时的**网页通道**实现：把搜索引擎结果页抓回来，从链接里还原结果列表。
 *
 * **为什么要有它**：文档口径是「不配 Key 也能搜（走网页通道）」，但此前唯一的执行面是
 * `browser_open`——而它受「允许 AI 控制浏览器」门控，该开关**默认关**。于是开箱状态下
 * 「没配 Key 也搜不了」（2026-09-20 真机走查实测：`web_search` 不装配 + `browser_open`
 * 被拒，模型只能改用沙箱 curl 兜底）。这里把那条路做进搜索工具本身：
 * **只读一次网页**，复用与 `browser_open` 同一个 `fetchPageSnapshot`（同时限、同大小上限、
 * 同云元数据拦截），因此不引入「让 agent 操作页面」的能力，也就不需要那个开关。
 *
 * 边界如实写在返回值里：拿到的是 HTML 里的链接，**不是结构化结果**；带反爬/验证码的
 * 引擎会失败（实测 Bing / Baidu 可以，Google 基本不行）。
 */

export const WEB_CHANNEL_ENGINES = [
  {
    id: "bing",
    label: "Bing",
    url: (query: string) =>
      `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    id: "baidu",
    label: "百度",
    url: (query: string) =>
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  },
] as const;

export type WebChannelEngineId = (typeof WEB_CHANNEL_ENGINES)[number]["id"];

/**
 * 从 `extractElements` 的定位提示里取 href。
 *
 * **提示的形态是 `a[href="https://…"]`——带引号**（真机实测：按「不带引号」写正则会连
 * 结尾那个引号一起捕获，`new URL()` 直接抛，结果集恒为空）。这里三种形态都认。
 */
export function hrefFromHint(hint: string): string {
  const match = /href=(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/.exec(hint);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

/** 从快照元素里挑出「看起来是搜索结果」的链接（去重、剔掉引擎自己的导航链接）。 */
export function extractResultLinks(
  elements: readonly { tag: string; text: string; hint: string }[],
  options: { engineHost: string; limit: number },
): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const element of elements) {
    if (element.tag.toLowerCase() !== "a") continue;
    const href = hrefFromHint(element.hint);
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      continue; // 相对链接 / 锚点 / javascript: —— 拿不到绝对地址就不当结果
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.hostname.endsWith(options.engineHost)) continue;
    const title = element.text.trim();
    if (!title) continue;
    const link = url.toString();
    if (seen.has(link)) continue;
    seen.add(link);
    results.push({ title, link, content: "" });
    if (results.length >= options.limit) break;
  }
  return results;
}

/** 只要快照的这三段（避免把整个浏览器 service 拖进搜索插件）。 */
export interface PageSnapshotLike {
  title: string;
  text: string;
  elements: { tag: string; text: string; hint: string }[];
}

/**
 * 结果页要提取的元素数：搜索引擎的头部导航自己就占二三十条，默认 40 会让结果链接
 * 根本进不了列表（实测恒 0 条）。抓的是同一份 HTML，只是不提前截断。
 */
export const SEARCH_PAGE_ELEMENT_LIMIT = 300;

export function createWebChannelSearchTool(deps: {
  snapshot(
    url: string,
    options?: { elementLimit?: number },
  ): Promise<PageSnapshotLike>;
  engine?: WebChannelEngineId;
}): ToolDefinition {
  const engine =
    WEB_CHANNEL_ENGINES.find((item) => item.id === deps.engine) ??
    WEB_CHANNEL_ENGINES[0];
  const engineHost = new URL(engine.url("x")).hostname.replace(/^www\./, "");
  return {
    name: "web_search",
    description:
      `联网搜索：抓取 ${WEB_CHANNEL_ENGINES.map((e) => e.label).join(" / ")} 的结果页，返回标题与链接列表。` +
      "未配置搜索供应商 Key 时走这条路。**它只做静态抓取**：结果页若由脚本渲染或触发反爬，会返回 0 条并说明原因" +
      "（那两条真机实测都会发生）——这时改用 browser_navigate（连上受控浏览器后是真实渲染页）或让 execute 抓取。",
    scope: "shared",
    exposure: "deferred",
    access: "read",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索查询词" },
        num: { type: "number", description: "返回条数（1-20，默认 8）" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = String(args.query ?? "").trim();
      if (!query) throw new WebSearchError("web_search 需要 query 参数");
      const num = Math.min(
        Math.max(Math.floor(Number(args.num ?? 8)) || 8, 1),
        20,
      );
      const snapshot = await deps.snapshot(engine.url(query), {
        elementLimit: SEARCH_PAGE_ELEMENT_LIMIT,
      });
      const results = extractResultLinks(snapshot.elements, {
        engineHost,
        limit: num,
      });
      return {
        query,
        results,
        channel: "web",
        engine: engine.label,
        ...(results.length > 0
          ? { note: "以上是网页通道结果（页面链接，无结构化摘要）。" }
          : {
              /**
               * 0 条要说清「是引擎没给可解析的结果」，而不是让人以为「真的没结果」。
               * 2026-09-20 真机实测：Bing 的结果链接不落在静态 HTML 的锚点里（正文有结果
               * 文字、但没有外部链接的 href），百度直接回空白页——两者都抓不到。
               */
              note:
                "网页通道没解析出可用的结果链接：引擎对非浏览器请求返回的是脚本渲染页或反爬页" +
                "（真机实测 Bing / 百度都会这样），不是「搜不到」。可行的替代：" +
                "① 设置 → 供应商里配一个搜索供应商 Key（走结构化 API）；" +
                "② 设置 → 浏览器里打开「允许 AI 控制浏览器」并连接受控浏览器后用 browser_navigate" +
                "（拿到的是脚本渲染后的真实页面）；③ 用 execute 自己抓取。",
            }),
      };
    },
  };
}
