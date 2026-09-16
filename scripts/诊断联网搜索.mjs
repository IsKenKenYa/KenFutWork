#!/usr/bin/env node
/**
 * 联网搜索验收脚本（真 Key 专用，不被 CI 调用）。
 *
 * 背景：`KENFUTWORK_SEARCH_API_KEY` 是秘塔的付费 Key，只能由用户提供——没有它时
 * 「真实检索结果」这一格无法验收（此前只验收了「替身端点验缝 + 真实端点验契约与
 * 错误语义」）。拿到 Key 后跑这一条命令即可完成验收：
 *
 *   node scripts/诊断联网搜索.mjs                 # 读 .env.local 里的 Key
 *   node scripts/诊断联网搜索.mjs --key=sk-xxx    # 或直接给 Key
 *   node scripts/诊断联网搜索.mjs --query="..."   # 换检索词（缺省「Python 3.13 新特性」）
 *
 * 判据（与 `features/search/web-search.ts` 的契约一致）：
 * - 成功：打印 webpages 的标题/链接/摘要（说明真实检索可用）；
 * - 业务错误：秘塔用 HTTP 200 承载 `{errCode, errMsg}`，本脚本会原样报出来
 *   （如「API密钥无效」），并给出可执行的下一步。
 *
 * 注意：若 `.env.local` 里还留着 `KENFUTWORK_SEARCH_ENDPOINT`（联调用的替身端点），
 * 本脚本**不会**用它——验收真实检索必须打真实端点，脚本会显式提醒。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const METASO_ENDPOINT = "https://metaso.cn/api/v1/search";

function readEnvLocal() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const text = readFileSync(join(root, ".env.local"), "utf8");
    const env = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const envLocal = readEnvLocal();
const key =
  argOf("key") ??
  envLocal.KENFUTWORK_SEARCH_API_KEY ??
  process.env.KENFUTWORK_SEARCH_API_KEY;
const query = argOf("query") ?? "Python 3.13 新特性";
const endpoint = argOf("endpoint") ?? METASO_ENDPOINT;

if (!key) {
  console.error(
    "缺少 KENFUTWORK_SEARCH_API_KEY：请把秘塔 Key 写进 .env.local，或用 --key=sk-xxx 传入。",
  );
  process.exit(1);
}
if (endpoint !== METASO_ENDPOINT || envLocal.KENFUTWORK_SEARCH_ENDPOINT) {
  console.warn(
    `注意：.env.local 里配了 KENFUTWORK_SEARCH_ENDPOINT=${envLocal.KENFUTWORK_SEARCH_ENDPOINT ?? ""}` +
      "（联调替身端点）。本脚本按真实端点验收，不使用该覆盖。",
  );
}
if (key === "local-dev-standin-key") {
  console.error(
    "当前 Key 是联调替身用的假 Key，不是真实秘塔 Key——请换成有效 Key 再跑。",
  );
  process.exit(1);
}

console.log(
  `端点：${endpoint}\n检索词：${query}\nKey：${key.slice(0, 6)}…（${key.length} 字符）\n`,
);

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  },
  // 秘塔只认 q/scope/size/page（与 web-search.ts 保持一致）
  body: JSON.stringify({ q: query, scope: "webpage", size: "5", page: "1" }),
}).catch((error) => {
  console.error(`请求失败（网络层）：${error.message}`);
  process.exit(1);
});

console.log(`HTTP ${response.status}`);
const payload = await response.json().catch(() => null);

// 秘塔用 HTTP 200 承载业务错误
const errCode = Number(payload?.errCode ?? 0);
if (errCode) {
  console.error(
    `上游业务错误：errCode=${errCode} errMsg=${payload?.errMsg ?? "(空)"}\n` +
      "→ 这条路径正是产品会透传给用户的可读原因（GUI 实测已验证）。请检查 Key 是否有效/是否欠费。",
  );
  process.exit(2);
}
if (!response.ok) {
  console.error(`请求被拒（HTTP ${response.status}），请检查网络或代理。`);
  process.exit(1);
}

const results = Array.isArray(payload?.webpages)
  ? payload.webpages
  : Array.isArray(payload?.results)
    ? payload.results
    : [];
if (results.length === 0) {
  console.error("连通且无业务错误，但返回 0 条结果——请换检索词再试。");
  process.exit(1);
}

console.log(`\n✅ 真实检索可用，返回 ${results.length} 条：`);
for (const [index, item] of results.entries()) {
  const title = String(item.title ?? "(无标题)");
  const link = String(item.link ?? item.url ?? "");
  const snippet = String(item.snippet ?? item.content ?? item.summary ?? "");
  console.log(
    `\n${index + 1}. ${title}\n   ${link}\n   ${snippet.slice(0, 120)}`,
  );
}
console.log(
  "\n下一步：把 Key 留在 .env.local（并删掉 KENFUTWORK_SEARCH_ENDPOINT 那行），重启服务后在 GUI 里让 agent 调 web_search 复验端到端。",
);
