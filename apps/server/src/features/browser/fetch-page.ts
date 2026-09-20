/**
 * 受控网页抓取与元素提取（R3-4「选择网页元素加入聊天」+ R5-4「允许 AI 控制浏览器」共用）。
 *
 * **为什么是服务端抓取而不是读 iframe 的 DOM**：右栏浏览器是跨源 iframe，读不到 DOM；
 * 只有 CDP / 浏览器扩展能拿到渲染后的 DOM。这一版做的是**静态快照**：
 * 服务端把页面 HTML 抓回来，提取纯文本与可交互元素（链接/按钮/输入/图片/标题）。
 * 边界如实写在界面上：脚本渲染出来的内容、登录态页面、提交后的表单都看不到。
 *
 * 安全口径（这是唯一一处「服务端替用户访问任意 URL」的地方，故逐条写死）：
 * - 只允许 http/https；
 * - 只拦**云元数据地址**（169.254.169.254 / 100.100.100.200），不拦内网——
 *   自托管/桌面形态下「抓本机 dev server」正是主要用法；
 * - 8 秒超时、512KB 上限、最多 3 次重定向（超出即报错而不是继续跟）。
 */

export const BROWSER_FETCH_TIMEOUT_MS = 8_000;
export const BROWSER_FETCH_MAX_BYTES = 512 * 1024;
export const BROWSER_FETCH_MAX_REDIRECTS = 3;

/** 云元数据地址：抓它没有任何产品价值，只有 SSRF 风险。 */
const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
]);

export interface PageElement {
  tag: string;
  /** 元素上能看到的文字（按钮/链接/标题）；输入类给 placeholder 或 name。 */
  text: string;
  /** 定位提示（**不是**严格 CSS 选择器）：id/href/name/type 这类稳定属性。 */
  hint: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
}

/**
 * 浏览器能力的 **Service Definition**（能力缝三元组：定义 + 提供者 + 消费方）。
 * 消费方有两处：右栏面板的快照端点（人）与 `browser_open` 工具（agent）。
 */
export interface BrowserService {
  /** 静态快照（无需浏览器）：抓 HTML 提元素。 */
  snapshot(
    url: string,
    options?: { elementLimit?: number },
  ): Promise<PageSnapshot>;
  /** CDP 会话（「连接到 Chrome」/「自动截图」的执行面；未连接时各方法抛可读错误）。 */
  cdp: import("./cdp-session.js").CdpBrowserSession;
}

export function createBrowserService(
  cdp: import("./cdp-session.js").CdpBrowserSession,
): BrowserService {
  return {
    snapshot: (url, options) => fetchPageSnapshot(url, options ?? {}),
    cdp,
  };
}

export class BrowserFetchError extends Error {
  readonly code: "invalid_url" | "blocked_host" | "fetch_failed" | "too_large";
  constructor(code: BrowserFetchError["code"], message: string) {
    super(message);
    this.name = "BrowserFetchError";
    this.code = code;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

/** HTML 实体还原（与前端 search-results 同一套常见实体；未知实体原样保留）。 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const isHex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(
          body.slice(isHex ? 2 : 1),
          isHex ? 16 : 10,
        );
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/**
 * 剥掉不会作为「正文」呈现的三段：脚本、样式、注释。
 * 漏掉这一步时正文里会混进 JS 源码（实测 `var x = 1;` 出现在页面文本里）。
 */
function stripNonContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 取一个属性的值（双引号 / 单引号 / 裸值三种写法都吃）。
 *
 * **必须用 String.raw**：写成普通模板字符串时 `\b`、`\s` 会被当成转义（`\b` = 退格符），
 * 拼出来的正则根本不匹配属性——实测「所有链接的定位提示都退化成 `a`」。
 */
function attr(tag: string, name: string): string | null {
  const pattern = String.raw`\b${name}\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))`;
  const match = new RegExp(pattern, "i").exec(tag);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim() || null;
}

/**
 * 从 HTML 里提取「可交互元素」。
 *
 * 顺序即文档顺序（界面按这个顺序列），每类各取前 {@link limit} 条：
 * 链接 / 按钮 / 输入 / 图片 / 标题。**不做 DOM 解析**（服务端没有 DOM）——
 * 正则够用，且结果里给的是「文字 + 提示」，不承诺严格选择器（见 PageElement.hint 注释）。
 */
export function extractElements(html: string, limit = 40): PageElement[] {
  const cleaned = stripNonContent(html);
  const elements: PageElement[] = [];
  const push = (element: PageElement) => {
    if (elements.length < limit && element.text) elements.push(element);
  };

  for (const match of cleaned.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const text = stripTags(match[0].replace(tag, "")).slice(0, 120);
    const href = attr(tag, "href");
    push({
      tag: "a",
      text,
      hint: href ? `a[href="${href}"]` : "a",
    });
  }
  for (const match of cleaned.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    const text = stripTags(match[0].replace(tag, "")).slice(0, 120);
    const id = attr(tag, "id");
    push({ tag: "button", text, hint: id ? `button#${id}` : "button" });
  }
  for (const match of cleaned.matchAll(/<input\b[^>]*\/?>/gi)) {
    const tag = match[0];
    const type = attr(tag, "type") ?? "text";
    const name = attr(tag, "name");
    const placeholder = attr(tag, "placeholder");
    push({
      tag: "input",
      text: placeholder ?? name ?? `(${type})`,
      hint: `input[type="${type}"]${name ? `[name="${name}"]` : ""}`,
    });
  }
  for (const match of cleaned.matchAll(/<img\b[^>]*\/?>/gi)) {
    const tag = match[0];
    const alt = attr(tag, "alt");
    push({
      tag: "img",
      text: alt ?? "(图片)",
      hint: attr(tag, "src") ? "img" : "img",
    });
  }
  for (const match of cleaned.matchAll(/<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi)) {
    const level = match[1];
    const tag = match[0].slice(0, match[0].indexOf(">") + 1);
    push({
      tag: `h${level}`,
      text: stripTags(match[0].replace(tag, "")).slice(0, 120),
      hint: `h${level}`,
    });
  }
  return elements;
}

/** 页面标题（<title>；没有就回落首个 h1）。 */
export function extractTitle(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) {
    const text = stripTags(title[1] ?? "");
    if (text) return text.slice(0, 200);
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return h1 ? stripTags(h1[1] ?? "").slice(0, 200) : "";
}

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * 提取多少个元素（缺省 40）。
   *
   * 为什么需要调大：`extractElements` 是**从头截取**的，而搜索引擎结果页的头部导航
   * 本身就有二三十个链接——用默认 40 条抓 Bing，结果链接根本进不了列表
   * （2026-09-20 实测：`web_search` 网页通道恒返回 0 条）。搜索通道因此要显式调大。
   */
  elementLimit?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
}

/**
 * 抓取一个 http/https 页面并给出快照（标题 + 正文文本 + 可交互元素）。
 * 失败一律抛 {@link BrowserFetchError}（可读原因，不返回半截结果）。
 */
export async function fetchPageSnapshot(
  rawUrl: string,
  options: FetchPageOptions = {},
): Promise<PageSnapshot> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new BrowserFetchError("invalid_url", "地址不是合法 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserFetchError("invalid_url", "只支持 http / https 地址。");
  }
  if (BLOCKED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new BrowserFetchError(
      "blocked_host",
      "这是云元数据地址（169.254.169.254 一类），不抓取。",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // 明确的 UA：不少站点对无 UA 的请求直接回兜底页
        "user-agent": "KenFutWork/1.0 (+local agent workspace)",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (error) {
    clearTimeout(timer);
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `抓取超时（> ${options.timeoutMs ?? BROWSER_FETCH_TIMEOUT_MS}ms）`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new BrowserFetchError("fetch_failed", `抓取失败：${reason}`);
  }
  clearTimeout(timer);

  const finalUrl = response.url || url.toString();
  if (!response.ok) {
    throw new BrowserFetchError(
      "fetch_failed",
      `目标返回 HTTP ${response.status}（${finalUrl}）`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = options.maxBytes ?? BROWSER_FETCH_MAX_BYTES;
  if (buffer.byteLength > maxBytes) {
    throw new BrowserFetchError(
      "too_large",
      `页面超过上限（${Math.round(buffer.byteLength / 1024)}KB > ${Math.round(maxBytes / 1024)}KB）。`,
    );
  }
  const html = buffer.toString("utf8");
  return {
    url: finalUrl,
    title: extractTitle(html),
    text: stripTags(stripNonContent(html)).slice(0, 20_000),
    elements: extractElements(html, options.elementLimit ?? 40),
  };
}
