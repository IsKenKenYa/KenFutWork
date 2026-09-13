#!/usr/bin/env node
/**
 * Supabase 专有对象清点（去 Supabase 迁移的工作底账）。
 *
 * 用途：
 *   1. 默认模式：扫描 supabase/migrations/*.sql，输出「必须重写 / 可直接沿用」的
 *      对象清单与计数——《多端产品设计》§5 承诺的「差异清单」由此生成，避免手写漂移。
 *   2. --check 模式：只要有 Supabase 专有构造残留即非零退出（中性化完成后的门禁）。
 *
 * 用法：
 *   node scripts/supabase-inventory.mjs            # 打印报告
 *   node scripts/supabase-inventory.mjs --json     # 机器可读
 *   node scripts/supabase-inventory.mjs --check    # 门禁：有残留即失败
 *
 * 口径：按「整文件」扫描而非逐行，避免多行 SQL 漏计；计数口径与
 * docs/tech/去Supabase-差异清单.md 一致，两者以本脚本输出为准。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const countMatches = (text, re) => (text.match(re) ?? []).length;

/** 取每个匹配的第一个捕获组（正则必须有捕获组）。 */
/**
 * URL 中性化迁移：它们**专门用来**把硬编码云 URL 从数据里改写掉，语句里必然出现
 * 被改写的字面量（`replace(<云 URL>, '')`）。把这些字面量计入残留，等于惩罚
 * 「去除残留」这件事本身——历史迁移文件不可改（immutable），该指标会永久卡在历史值上。
 * 故口径（2026-09-14）：残留统计**排除中性化迁移**；权威口径是「迁移序列执行完后的
 * 库内状态」（本次实测 0 处，见 docs/tech/改造计划.md §4.13）。
 */
const URL_NEUTRALIZER_MIGRATIONS = new Set([
  "20260914120000_localize_home_seed_urls.sql",
]);

function cloudUrlsExcludingNeutralizers(acc) {
  return Object.entries(acc.cloudUrlsByFile).reduce(
    (sum, [file, count]) =>
      URL_NEUTRALIZER_MIGRATIONS.has(file) ? sum : sum + count,
    0,
  );
}

function captureAll(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

const uniq = (list) => [...new Set(list)].sort();

/** 分离「策略内」与「函数体/表达式中」的 auth.uid()。 */
function splitAuthUid(text) {
  const spans = [];
  for (const m of text.matchAll(/create\s+policy[\s\S]*?;/gi)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  let inPolicy = 0;
  let inFunction = 0;
  for (const m of text.matchAll(/auth\.uid\(\)/g)) {
    if (spans.some(([s, e]) => m.index >= s && m.index < e)) inPolicy += 1;
    else inFunction += 1;
  }
  return { inPolicy, inFunction };
}

/** REFERENCES auth.users 所属的 CREATE TABLE（按语句切分，避免跨表误配）。 */
function tablesReferencingAuthUsers(text) {
  const tables = [];
  const positions = [];
  for (const m of text.matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w."]+)/gi,
  )) {
    positions.push({ name: m[1].replace(/"/g, ""), index: m.index });
  }
  positions.forEach((pos, i) => {
    const end = positions[i + 1]?.index ?? text.length;
    if (/references\s+auth\.users/i.test(text.slice(pos.index, end))) {
      tables.push(pos.name);
    }
  });
  return tables;
}

/** 挂在 auth.users 上的触发器（按 create trigger 切分语句边界）。 */
function triggersOnAuthUsers(text) {
  const out = [];
  for (const stmt of text.split(/create\s+trigger/i).slice(1)) {
    const m = stmt.match(/^\s+([\w]+)[\s\S]*?on\s+([\w."]+)/i);
    if (m && /auth\.users/i.test(m[2])) out.push(m[1]);
  }
  return out;
}

/** 策略清单（名 + 作用表）。 */
function policies(text) {
  return captureAll(text, /create\s+policy\s+"?([\w\s]+?)"?\s+on\s+([\w.]+)/gi)
    .length
    ? [
        ...text.matchAll(/create\s+policy\s+"?([\w\s]+?)"?\s+on\s+([\w.]+)/gi),
      ].map((m) => ({ name: m[1].trim(), table: m[2] }))
    : [];
}

/** 桶 id：按「整条 insert 语句」取引号内的小写 token（多行 VALUES 行首也算）。 */
function bucketsIn(text) {
  const out = [];
  for (const stmt of text.matchAll(
    /insert\s+into\s+storage\.buckets[\s\S]*?;/gi,
  )) {
    for (const q of stmt[0].matchAll(/['"]([a-z][a-z0-9-]*)['"]/g)) {
      out.push(q[1]);
    }
  }
  return out;
}

/** 函数清单（名 + SECURITY DEFINER + 是否用 auth.uid()）。 */
function functions(text) {
  const out = [];
  const re =
    /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(([\s\S]*?)(?=create\s+(?:or\s+replace\s+)?function|create\s+trigger|create\s+policy|$)/gi;
  for (const m of text.matchAll(re)) {
    out.push({
      name: m[1],
      securityDefiner: /security\s+definer/i.test(m[2]),
      usesAuthUid: /auth\.uid\(\)/i.test(m[2]),
    });
  }
  return out;
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const checkMode = process.argv.includes("--check");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const acc = {
    authUsersTables: [],
    authUsersTriggers: [],
    authUsersFromRefs: 0,
    authUidTotal: 0,
    authUidInPolicy: 0,
    authUidInFunction: 0,
    storageObjectsRefs: 0,
    storageBucketsRefs: 0,
    storagePolicies: [],
    buckets: [],
    roleGrants: {},
    grants: 0,
    extensions: [],
    schemas: {},
    cloudUrls: [],
    cloudUrlsByFile: {},
    cloudHosts: [],
    securityDefinerFns: [],
    fnsUsingAuthUid: [],
    publicTables: [],
    functions: [],
    policyCount: 0,
    rlsEnableCount: 0,
    securityDefinerCount: 0,
  };

  for (const file of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    acc.authUsersTables.push(...tablesReferencingAuthUsers(text));
    acc.authUsersTriggers.push(...triggersOnAuthUsers(text));
    acc.authUsersFromRefs += countMatches(text, /from\s+auth\.users/gi);

    const uid = splitAuthUid(text);
    acc.authUidTotal += uid.inPolicy + uid.inFunction;
    acc.authUidInPolicy += uid.inPolicy;
    acc.authUidInFunction += uid.inFunction;

    acc.storageObjectsRefs += countMatches(text, /storage\.objects/gi);
    acc.storageBucketsRefs += countMatches(text, /storage\.buckets/gi);
    acc.storagePolicies.push(
      ...policies(text).filter((p) => p.table.startsWith("storage.")),
    );
    acc.buckets.push(...bucketsIn(text));

    for (const role of [
      "authenticated",
      "service_role",
      "anon",
      "supabase_admin",
    ]) {
      const n = countMatches(text, new RegExp(`\\bto\\s+${role}\\b`, "gi"));
      if (n > 0) acc.roleGrants[role] = (acc.roleGrants[role] ?? 0) + n;
    }
    acc.grants += countMatches(text, /^\s*grant\b/gim);

    acc.extensions.push(
      ...captureAll(text, /create\s+extension[^;]*?([a-z][\w-]*)\s+with/gi),
      ...captureAll(text, /create\s+extension[^;]*?\b(pgmq)\b/gi),
    );

    for (const schema of [
      "auth",
      "storage",
      "extensions",
      "vault",
      "graphql",
      "realtime",
    ]) {
      const n = countMatches(text, new RegExp(`\\b${schema}\\.`, "gi"));
      if (n > 0) acc.schemas[schema] = (acc.schemas[schema] ?? 0) + n;
    }

    const urls = captureAll(
      text,
      /(https?:\/\/[\w.-]*supabase\.co[^\s'")]*)/gi,
    );
    acc.cloudUrls.push(...urls);
    if (urls.length > 0) {
      acc.cloudUrlsByFile[file] = urls.length;
    }
    acc.cloudHosts.push(...urls.map((u) => new URL(u).host));

    acc.policyCount += countMatches(text, /create\s+policy/gi);
    acc.rlsEnableCount += countMatches(
      text,
      /enable\s+row\s+level\s+security/gi,
    );
    acc.publicTables.push(
      ...captureAll(
        text,
        /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([\w]+)/gi,
      ),
    );

    const fns = functions(text);
    acc.functions.push(...fns.map((f) => f.name));
    acc.securityDefinerFns.push(
      ...fns.filter((f) => f.securityDefiner).map((f) => f.name),
    );
    acc.fnsUsingAuthUid.push(
      ...fns.filter((f) => f.usesAuthUid).map((f) => f.name),
    );
    acc.securityDefinerCount += countMatches(text, /security\s+definer/gi);
  }

  const report = {
    migrationFiles: files.length,
    rewrite: [
      ["FK → auth.users 的表", uniq(acc.authUsersTables)],
      ["auth.users 上的触发器", uniq(acc.authUsersTriggers)],
      ["遍历 auth.users 的语句", acc.authUsersFromRefs],
      ["auth.uid() 总数", acc.authUidTotal],
      ["  其中策略内", acc.authUidInPolicy],
      ["  其中函数体/表达式", acc.authUidInFunction],
      ["用 auth.uid() 的函数", uniq(acc.fnsUsingAuthUid)],
      ["SECURITY DEFINER 函数", uniq(acc.securityDefinerFns)],
      ["storage.objects 引用", acc.storageObjectsRefs],
      ["storage.buckets 引用", acc.storageBucketsRefs],
      ["storage 上的策略", uniq(acc.storagePolicies.map((p) => p.name))],
      ["storage 桶", uniq(acc.buckets)],
      ["角色授权 to <role>", acc.roleGrants],
      ["GRANT 语句", acc.grants],
      ["CREATE EXTENSION", uniq(acc.extensions)],
      ["Supabase schema 引用", acc.schemas],
      ["硬编码云端 URL", acc.cloudUrls.length],
      [
        "硬编码云端 URL（排除中性化迁移后的净值）",
        cloudUrlsExcludingNeutralizers(acc),
      ],
      ["硬编码云端 URL（按文件）", acc.cloudUrlsByFile],
      ["硬编码云主机", uniq(acc.cloudHosts)],
    ],
    keep: [
      ["public 业务表", uniq(acc.publicTables)],
      ["函数（含可复用 RPC）", uniq(acc.functions)],
      ["CREATE POLICY 总数", acc.policyCount],
      ["ENABLE RLS 总数", acc.rlsEnableCount],
    ],
  };

  const fmt = ([key, value]) => {
    if (Array.isArray(value)) {
      const head = `- ${key}：${value.length}`;
      return value.length > 0 ? `${head}\n    ${value.join(", ")}` : head;
    }
    if (value && typeof value === "object") {
      return `- ${key}：${Object.entries(value)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`;
    }
    return `- ${key}：${value}`;
  };

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          migrationFiles: report.migrationFiles,
          rewrite: Object.fromEntries(
            report.rewrite.map(([k, v]) => [k.trim(), v]),
          ),
          keep: Object.fromEntries(report.keep.map(([k, v]) => [k, v])),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`# Supabase 专有对象清点（${report.migrationFiles} 个迁移）\n`);
    console.log("## 必须重写 / 剔除");
    for (const row of report.rewrite) console.log(fmt(row));
    console.log("\n## 可直接沿用");
    for (const row of report.keep) console.log(fmt(row));
  }

  if (checkMode) {
    const residual =
      acc.authUidTotal +
      uniq(acc.authUsersTables).length +
      uniq(acc.authUsersTriggers).length +
      acc.storageObjectsRefs +
      cloudUrlsExcludingNeutralizers(acc);
    if (residual > 0) {
      console.error(
        `\n[gate] 仍有 Supabase 专有构造残留（${residual} 处）：auth.uid()=${acc.authUidTotal}、auth.users FK 表=${uniq(acc.authUsersTables).length}、auth.users 触发器=${uniq(acc.authUsersTriggers).length}、storage.objects=${acc.storageObjectsRefs}、硬编码云 URL=${cloudUrlsExcludingNeutralizers(acc)}——中性化未完成。`,
      );
      process.exitCode = 1;
    } else {
      console.log("\n[gate] 未发现 Supabase 专有构造残留。");
    }
  }
}

main();
