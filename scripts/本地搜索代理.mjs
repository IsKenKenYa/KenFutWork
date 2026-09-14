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
 */
import { createServer } from "node:http";

const PORT = Number(
  process.env.LOOMIC_SEARCH_PORT ?? process.env.MOCK_SEARCH_PORT ?? 9099,
);

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

const server = createServer(async (req, res) => {
  // 技能 ZIP 导入联调：把测试用技能包直接喂给「从链接导入」
  if (req.method === "GET" && req.url?.startsWith("/kfw-skill.zip")) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(new URL("./kfw-zip-import-check.zip", import.meta.url));
    res.writeHead(200, { "content-type": "application/zip", "access-control-allow-origin": "*" });
    res.end(buf);
    return;
  }
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
      `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
      },
    );
    const html = await upstream.text();
    const webpages = parseBing(html).slice(0, size);
    console.log(`[search-proxy] q="${q}" -> ${webpages.length} 条（bing ${upstream.status}）`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ webpages }));
  } catch (error) {
    console.log(`[search-proxy] 抓取失败：${error.message}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ errCode: 5001, errMsg: `上游抓取失败：${error.message}` }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[search-proxy] 本地搜索代理监听 http://127.0.0.1:${PORT}/search`);
});
