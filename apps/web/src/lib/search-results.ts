/**
 * web_search 结果的客户端解析（纯函数）。
 *
 * 背景：联网搜索结果随 `tool.completed` 的 `output` 一起送到前端，但界面此前
 * 不做任何呈现——用户看不到来源，无法判断模型引用是否可信（审计项
 * 「前端无搜索结果/引用渲染」）。这里把「输出 → 可渲染来源列表」收敛成纯函数，
 * 同时服务实时流与历史消息（历史走持久化的 `tool_activities`，形状相同）。
 *
 * 输入形态有两种，都要吃：
 * - 结构化对象 `{ query, results: [...] }`（工具直连返回时的形状）；
 * - JSON 字符串（经事件序列化/落库往返后的常见形态）。
 */

export interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  /** 展示用的主机名（解析失败回落原串）。 */
  host: string;
}

export interface SearchResultView {
  query: string;
  sources: SearchSource[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** host 展示：去掉 www. 前缀，失败原样返回。 */
/**
 * 搜索上游（必应抓取一类）给的是 HTML 片段：`&ensp;` `&#0183;` `&amp;` 这类实体原样上屏
 * 就是乱码（实测：摘要里出现字面量 "&ensp;&#0183;&ensp;"）。这里解掉常见实体——
 * 只做「文本还原」，不解析标签（标签由渲染层当纯文本处理，不做富文本）。
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ensp: " ",
    emsp: " ",
    thinsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    laquo: "«",
    raquo: "»",
    ldquo: "“",
    rdquo: "”",
    lsquo: "‘",
    rsquo: "’",
    middot: "·",
  };
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
      return named[body.toLowerCase()] ?? match;
    },
  );
}

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * 从工具输出里取出搜索来源。
 * 非 web_search / 形状不符时返回 null（调用方据此走通用渲染）。
 */
export function parseSearchResultView(
  toolName: string,
  output: unknown,
): SearchResultView | null {
  if (toolName !== "web_search") {
    return null;
  }

  let payload: unknown = output;
  if (typeof output === "string") {
    try {
      payload = JSON.parse(output);
    } catch {
      return null;
    }
  }
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const rawResults = record.results;
  if (!Array.isArray(rawResults)) {
    return null;
  }

  const sources: SearchSource[] = [];
  for (const item of rawResults) {
    const entry = asRecord(item);
    if (!entry) continue;
    const url = readString(entry.link) || readString(entry.url);
    if (!url) continue;
    sources.push({
      title: decodeHtmlEntities(readString(entry.title)) || url,
      url,
      snippet: decodeHtmlEntities(readString(entry.content)),
      host: sourceHost(url),
    });
  }

  // 空结果也算「识别到了」——界面应显示「无结果」而不是回落到原始 JSON 转储
  return {
    query: readString(record.query),
    sources,
  };
}
