/**
 * 本地联网搜索代理：把秘塔的接口契约接到真实搜索引擎上。
 *
 * **它不是测试替身，而是一条受支持的配置**：`LOOMIC_SEARCH_ENDPOINT` 正是为
 * 「镜像 / 代理 / 联调」准备的覆盖点（见 `features/search/plugin.ts`），本脚本实现与
 * `features/search/web-search.ts` 完全一致的契约——请求 `POST {q, scope, size, page}`
 * + `Bearer` 鉴权 → 响应 `{ webpages: [{ title, link, snippet }] }`，业务错误同样走
 * 秘塔口径（HTTP 200 + `{ errCode, errMsg }`）——只是检索结果来自真实 Bing 而非秘塔。
 *
 * 什么时候用它：**没有秘塔 Key 时**。秘塔按量付费、无免费额度（实测无 Key / 空 Bearer /
 * 任意字符串 Key 一律 `errCode 2005`），没有 Key 时 search 插件按 enabled 判定不装配、
 * `web_search` 不注册。把本代理跑起来并在 `.env.local` 里指过去，联网搜索即可用：
 *
 *   node scripts/本地搜索代理.mjs        # 监听 127.0.0.1:9099（可用 LOOMIC_SEARCH_PORT 改）
 *
 *   # .env.local：
 *   LOOMIC_SEARCH_API_KEY=<任意非空字符串，本代理只校验格式>
 *   LOOMIC_SEARCH_ENDPOINT=http://127.0.0.1:9099/search
 *
 * 注意：结果来自必应网页抓取，**不是秘塔**；要接入秘塔本体就去掉 `LOOMIC_SEARCH_ENDPOINT`
 * 并填真实 Key（用 `node scripts/诊断联网搜索.mjs` 验收）。代理不可达、上游改版、以及
 * 「上游回兜底页」都会返回可读的 `errCode/errMsg`，不会伪装成「搜到 0 条」，更不会把跑题的
 * 页面当来源交出去（见 `looksRelevant`）。**代价是命中率**：实测 6 个中文查询里 3 个正常返回、
 * 3 个被拦成 5002——被拦时是「搜索失败」，不是「这个查询没结果」，模型会看到原因。
 * 这是抓取式上游的天花板，要稳定就把 `LOOMIC_SEARCH_ENDPOINT` 指向真正的搜索 API。
 *
 * 另两个可选环境变量：`LOOMIC_SEARCH_PORT`（监听端口，缺省 9099）、
 * `LOOMIC_SEARCH_UPSTREAM`（上游搜索页，缺省必应；换引擎或验证解析失配时用）。
 *
 * 上游必须带中文市场参数（`mkt=zh-CN&cc=CN`）：不带时必应对「无 Cookie 的程序化抓取」
 * 会回**跑题的兜底页**——实测中文查询会拿到单位换算站、邮轮游记、越南股票站这类完全无关的
 * 结果，且每次查询换一批域名，看上去像「搜到了」实则跑题；带上后同一批查询返回相关结果
 * （`Excalidraw 画布 数据保存 格式` → excalidraw.com / github / 知乎 / 菜鸟教程）。这是上游
 * 行为差异，与契约无关；但少了它，代理给出的「来源」会误导模型与用户。
 */
import { createServer } from "node:http";

const PORT = Number(
  process.env.LOOMIC_SEARCH_PORT ?? process.env.MOCK_SEARCH_PORT ?? 9099,
);
/** 上游搜索结果页；改这个可以换搜索引擎（也用于验证解析失配时的报错路径）。 */
const UPSTREAM =
  process.env.LOOMIC_SEARCH_UPSTREAM ?? "https://www.bing.com/search";

function decodeEntities(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Bing 结果 href 是 `bing.com/ck/a?...&u=a1<base64url>` 跳转壳，解出真实目标。 */
function unwrapBingLink(href) {
  const raw = href.replace(/&amp;/g, "&");
  if (!raw.includes("bing.com/ck/a")) return raw;
  const u = new URL(raw).searchParams.get("u");
  if (!u?.startsWith("a1")) return raw;
  try {
    const b64 = u.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return raw;
  }
}

function parseBing(html) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"/);
    const title = block.match(/<h2[^>]*>\s*<a[^>]*>(.*?)<\/a>/s);
    const snippet = block.match(/<p[^>]*>(.*?)<\/p>/s);
    if (!link) continue;
    out.push({
      title: decodeEntities(title?.[1] ?? ""),
      link: unwrapBingLink(link[1]),
      snippet: decodeEntities(snippet?.[1] ?? ""),
    });
  }
  return out;
}

/**
 * 查询词元：ASCII 词（≥3 字符）+ 中文二元组。只用于「结果与查询是否沾边」的粗判。
 */
function queryTokens(q) {
  const tokens = new Set();
  for (const m of q.matchAll(/[a-z0-9][a-z0-9.+#-]{2,}/gi)) {
    tokens.add(m[0].toLowerCase());
  }
  const cjk = [...q].filter((c) => /[\u4e00-\u9fff]/.test(c));
  for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk[i] + cjk[i + 1]);
  return [...tokens];
}

/**
 * 结果是否与查询沾边。必应对「无 Cookie 的程序化抓取」会**间歇性**返回与查询完全无关的
 * 通用页（实测同一中文查询，一次是正常结果、下一次是单位换算站 / Windows 帮助页），这类页面
 * HTTP 200、字段齐全、解析条数正常，仅凭状态码和条数分辨不出来；唯一可行的信号是
 * 「结果里有多少查询词元」。单个**短**词元命中不算数——实测 `Next.js 16 App Router 新特性`
 * 会因通用词 `app` 命中而放行一批 Fortnite/Epic 商店页；故要求「长词元（≥6 字符）命中」
 * 或「至少两个词元命中」。一个字都查不出的查询（词元为空）不做判断。
 *
 * 这是启发式，不是保证：会误放（结果碰巧含同词元）也会误拦（同义词查询）。它的价值在于把
 * 最有害的一类失败（看起来像来源、实则跑题的页面喂给模型）变成可读的报错。
 */
function looksRelevant(webpages, tokens) {
  if (tokens.length === 0) return true;
  const blob = webpages
    .map((p) => `${p.title} ${p.snippet}`)
    .join(" ")
    .toLowerCase();
  const hits = tokens.filter((token) => blob.includes(token));
  return hits.length >= 2 || hits.some((token) => token.length >= 6);
}

/** 抓一次上游并解析，连同判定故障所需的元信息一起返回。 */
async function searchUpstream(q) {
  const upstream = await fetch(
    `${UPSTREAM}?q=${encodeURIComponent(q)}&setlang=zh-CN&mkt=zh-CN&cc=CN`,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    },
  );
  const html = await upstream.text();
  return {
    webpages: parseBing(html),
    ok: upstream.ok,
    status: upstream.status,
    contentType: upstream.headers.get("content-type") ?? "",
    htmlLength: html.length,
  };
}

/**
 * 请求处理。整个函数体裹在 try/catch 里：代理是常驻进程，**一个坏请求不能把它带走**
 * ——此前它内部还挂过一条测试用的 ZIP 路由，移动脚本后那条相对路径失效（ENOENT），
 * 未捕获的 rejection 直接让进程退出，表现为「搜索突然不可用」且看不到原因。
 */
async function handleRequest(req, res) {
  if (req.method !== "POST" || !req.url?.startsWith("/search")) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ errCode: 405, errMsg: "只支持 POST /search" }));
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth.length < 12) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ errCode: 2005, errMsg: "API密钥无效" }));
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ errCode: 2001, errMsg: "请求体不是 JSON" }));
    return;
  }
  const q = String(body.q ?? "").trim();
  if (!q) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ errCode: 2002, errMsg: "缺少 q 参数" }));
    return;
  }
  const size = Math.min(Math.max(Number(body.size) || 8, 1), 20);
  const tokens = queryTokens(q);
  try {
    let attempt = await searchUpstream(q);
    /**
     * 与查询完全不沾边的结果一律不采信：先重试一次（兜底页常是一次抽风），仍不沾边就报错。
     * 绝不能把这类结果当来源交给模型——它会照着实实在在的标题与链接编出跑题的答案，
     * 比「搜索失败」危险得多。
     */
    if (attempt.webpages.length > 0 && !looksRelevant(attempt.webpages, tokens)) {
      console.log(`[search-proxy] q="${q}" -> 结果与查询无词面重合，重试一次`);
      const retry = await searchUpstream(q);
      if (retry.webpages.length > 0 && looksRelevant(retry.webpages, tokens)) {
        attempt = retry;
      } else {
        const reason =
          "上游返回的结果与查询没有任何词面重合（必应对程序化抓取会间歇性回兜底页），本次结果未采信，请稍后重试。";
        console.log(`[search-proxy] q="${q}" -> ${reason}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errCode: 5002, errMsg: reason }));
        return;
      }
    }
    const { webpages: parsed } = attempt;
    /**
     * 「抓到了东西但不是搜索结果页」必须**报错**，不能返回空数组：空数组会被产品当成
     * 「搜到 0 条」呈现给用户，把「代理坏了/端点配错/上游改版」伪装成「这个词没结果」，
     * 排查时完全无从下手。两种可判定的情形各自给一句话：
     * ① 拿到的不是 HTML（content-type 不对）——多半是 ENDPOINT/UPSTREAM 配错；
     * ② 是大页面却一条都解不出来——多半是上游改版，选择器失配。
     */
    const looksLikeHtml =
      attempt.contentType.includes("text/html") || attempt.contentType === "";
    const looksLikeResultsPage = attempt.htmlLength > 20_000;
    if (parsed.length === 0 && attempt.ok) {
      const reason = !looksLikeHtml
        ? `上游返回的不是网页（content-type: ${attempt.contentType || "未知"}），请检查上游地址是否配错。`
        : looksLikeResultsPage
          ? "上游页面结构已变（大页面却解析不到结果），请更新搜索代理的解析规则。"
          : "";
      if (reason) {
        console.log(`[search-proxy] q="${q}" -> 0 条被判定为故障：${reason}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errCode: 5002, errMsg: reason }));
        return;
      }
    }
    const webpages = parsed.slice(0, size);
    console.log(
      `[search-proxy] q="${q}" -> ${webpages.length} 条（${new URL(UPSTREAM).host} ${attempt.status}）`,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ webpages }));
  } catch (error) {
    console.log(`[search-proxy] 抓取失败：${error.message}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ errCode: 5001, errMsg: `上游抓取失败：${error.message}` }));
  }
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    console.log(`[search-proxy] 请求处理异常（已兜住，进程继续）：${error.message}`);
    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ errCode: 5003, errMsg: `代理内部错误：${error.message}` }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[search-proxy] 本地搜索代理监听 http://127.0.0.1:${PORT}/search`);
});
