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
 * 并填真实 Key（用 `node scripts/诊断联网搜索.mjs` 验收）。代理不可达或上游改版都会返回
 * 可读的 `errCode/errMsg`，不会伪装成「搜到 0 条」。
 *
 * 另两个可选环境变量：`LOOMIC_SEARCH_PORT`（监听端口，缺省 9099）、
 * `LOOMIC_SEARCH_UPSTREAM`（上游搜索页，缺省必应；换引擎或验证解析失配时用）。
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
  try {
    const upstream = await fetch(
      `${UPSTREAM}?q=${encodeURIComponent(q)}&setlang=zh-CN`,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      },
    );
    const html = await upstream.text();
    const parsed = parseBing(html);
    /**
     * 「抓到了东西但不是搜索结果页」必须**报错**，不能返回空数组：空数组会被产品当成
     * 「搜到 0 条」呈现给用户，把「代理坏了/端点配错/上游改版」伪装成「这个词没结果」，
     * 排查时完全无从下手。两种可判定的情形各自给一句话：
     * ① 拿到的不是 HTML（content-type 不对）——多半是 ENDPOINT/UPSTREAM 配错；
     * ② 是大页面却一条都解不出来——多半是上游改版，选择器失配。
     */
    const contentType = upstream.headers.get("content-type") ?? "";
    const looksLikeHtml = contentType.includes("text/html") || contentType === "";
    const looksLikeResultsPage = html.length > 20_000;
    if (parsed.length === 0 && upstream.ok) {
      const reason = !looksLikeHtml
        ? `上游返回的不是网页（content-type: ${contentType || "未知"}），请检查上游地址是否配错。`
        : looksLikeResultsPage
          ? "上游页面结构已变（大页面却解析不到结果），请更新搜索代理的解析规则。"
          : "";
      if (reason) {
        console.log(
          `[search-proxy] q="${q}" -> 0 条被判定为故障：${reason}`,
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errCode: 5002, errMsg: reason }));
        return;
      }
    }
    const webpages = parsed.slice(0, size);
    console.log(
      `[search-proxy] q="${q}" -> ${webpages.length} 条（${new URL(UPSTREAM).host} ${upstream.status}）`,
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
