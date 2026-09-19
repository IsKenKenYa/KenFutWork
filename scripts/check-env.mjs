/**
 * env 名权威表机械门禁（治理三次同源事故：env 前缀迁移 / 包名迁移 / 零字节占位）。
 *
 * 权威表：tests/env-registry.json（唯一属主，仿 supabase-cleanup-baseline.json 的
 * 「机械基线放 tests/」模式）。四条规则：
 *   R1 登记——扫描面内所有 KENFUTWORK_ 前缀（及 LOOMIC_ 旧前缀）引用必须在表内，表外即 fail；
 *   R2 旧名白名单——LOOMIC_* 只允许出现在 legacy.allowedIn 文件与兼容 shim；
 *   R3 读者存活——active 条目的 readers[] 每个文件必须仍含该名（契约漂移即 fail）；
 *   R4 样例互锁——.env.example 的 KENFUTWORK_* 条目 ⊆ registry；inExamples=true
 *      的条目必须在样例中出现。
 *
 * 双入口：`pnpm test:env` 直接跑；tests/workspace.test.mjs 导入 checkEnv 挂门禁用例
 * （并含 fixture 正/负路径自校验——一个永远 PASS 的检查等于没有检查）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { fileURLToPath } from "node:url";

const REGISTRY_FILE = "tests/env-registry.json";
const EXAMPLES_FILE = ".env.example";

/** 扫描面：目录（递归）与单文件混合。排除产物/依赖/参考仓。 */
const SCAN_DIRS = [
  "apps/server/src",
  "apps/desktop/src-tauri/src",
  "apps/web/src",
  "packages/shared/src",
  "scripts",
];
const SCAN_FILES = [
  ".env.example",
  "apps/desktop/dev.sh",
  "apps/server/Dockerfile",
  "apps/desktop/package.json",
  "turbo.json",
];
const EXCLUDED_DIR_PARTS = [
  "node_modules",
  "target",
  "gen",
  ".next",
  "dist",
  "out",
  ".turbo",
  ".playwright-mcp",
];

/** R2 白名单：LOOMIC_* 引用的历史/兼容豁免（相对仓库根）。 */
const LEGACY_ALLOWED_FILES = new Set([
  // 兼容 shim 本体：LOOMIC_* → KENFUTWORK_* 一次性映射（新名优先）
  "apps/server/src/config/env.ts",
  // 盘点标注的「有意保留」：已执行迁移的历史陈述、事故记录注释
  "supabase/migrations/20260914250000_mcp_servers.sql",
]);

function walkFiles(dir, excludeParts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (excludeParts.some((part) => entry.name.includes(part))) continue;
      walkFiles(full, excludeParts, out);
    } else if (
      /\.(ts|tsx|mjs|js|rs|sh|json)$|\.env\.example$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function extractEnvNames(text) {
  const names = new Set();
  const pattern = /\b(KENFUTWORK|LOOMIC)_[A-Z0-9_]+/g;
  for (const match of text.matchAll(pattern)) names.add(match[0]);
  return names;
}

/** 样例文件的「名字=值」行提取：任意大写名（不限 KENFUTWORK 前缀），含注释行。 */
function extractExampleNames(text) {
  const names = new Set();
  for (const line of text.split("\n")) {
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (match) names.add(match[1]);
  }
  return names;
}

function readTextSafe(rootDir, relPath) {
  try {
    return readFileSync(join(rootDir, relPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * 校验入口：返回 { errors: string[], files: string[] }。
 * errors 为空即通过；files 是实际扫描过的文件清单（测试用它断言扫描面非空）。
 */
export function checkEnv({ rootDir }) {
  const errors = [];

  // 0. 权威表自身可解析
  let registry;
  try {
    registry = JSON.parse(readFileSync(join(rootDir, REGISTRY_FILE), "utf8"));
  } catch (error) {
    return {
      errors: [`权威表 ${REGISTRY_FILE} 无法解析：${error.message}`],
      files: [],
    };
  }
  const vars = registry.vars ?? {};
  const legacy = registry.legacy ?? {};

  // 1. 扫描面收集
  const files = [];
  for (const dir of SCAN_DIRS) {
    const absolute = join(rootDir, dir);
    try {
      if (!statSync(absolute).isDirectory()) continue;
    } catch {
      continue;
    }
    files.push(...walkFiles(absolute, EXCLUDED_DIR_PARTS));
  }
  for (const file of SCAN_FILES) {
    try {
      if (statSync(join(rootDir, file)).isFile())
        files.push(join(rootDir, file));
    } catch {
      // 缺失的样例/配置文件不算扫描面错误（R4 单独报）
    }
  }

  const legacyAllowed = new Set(
    Object.keys(legacy).length === 0
      ? []
      : Object.values(legacy).flatMap((entry) => entry.allowedIn ?? []),
  );

  // 2. R1+R2：逐文件引用对表
  for (const file of files) {
    const relPath = relative(rootDir, file).replaceAll("\\", "/");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const name of extractEnvNames(text)) {
      if (vars[name] !== undefined) continue;
      const isLegacy = name.startsWith("LOOMIC_");
      const legacyEntry = isLegacy ? legacy[name] : undefined;
      if (legacyEntry) {
        // R2：LOOMIC_* 只许在登记的白名单文件出现（出现一次登记一次，白名单没列即 fail）
        if (!legacyAllowed.has(relPath) && !LEGACY_ALLOWED_FILES.has(relPath)) {
          errors.push(
            `${relPath}: 旧前缀 ${name} 未在权威表 legacy[${name}].allowedIn 登记（改为 KENFUTWORK_* 或登记白名单）`,
          );
        }
        continue;
      }
      errors.push(
        `${relPath}: 环境变量 ${name} 未登记进 ${REGISTRY_FILE}（新增 env 先登记再使用）`,
      );
    }
  }

  // 3. R3：active 变量的读者文件必须仍含该名
  for (const [name, entry] of Object.entries(vars)) {
    if (entry.status !== "active") continue;
    for (const reader of entry.readers ?? []) {
      const text = readTextSafe(rootDir, reader);
      if (text === null) {
        errors.push(`${name} 的读者文件不存在或不可读：${reader}`);
        continue;
      }
      if (!text.includes(name)) {
        errors.push(
          `${name} 登记的读者 ${reader} 已不再引用该名（契约漂移——更新表或恢复读者）`,
        );
      }
    }
  }

  // 4. R4：.env.example 与 registry 互锁
  const exampleText = readTextSafe(rootDir, EXAMPLES_FILE);
  if (exampleText === null) {
    errors.push(`样例文件 ${EXAMPLES_FILE} 不存在。`);
  } else {
    const exampleNames = extractExampleNames(exampleText);
    for (const [name, entry] of Object.entries(vars)) {
      if (entry.status === "external") continue; // 第三方既有约定不进样例校验
      const inExample = exampleNames.has(name);
      if (entry.inExamples && !inExample) {
        errors.push(
          `${name} 标记 inExamples=true 但 ${EXAMPLES_FILE} 未登记。`,
        );
      }
      if (entry.inExamples === false && inExample) {
        errors.push(
          `${name} 标记 inExamples=false 但 ${EXAMPLES_FILE} 出现了它（从样例移除或改标记）。`,
        );
      }
    }
    for (const name of exampleNames) {
      if (vars[name] === undefined) {
        errors.push(
          `${EXAMPLES_FILE} 登记了 ${name} 但权威表没有它（改样例或先登记）。`,
        );
      }
    }
  }

  return { errors, files };
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const rootDir = process.cwd();
  const { errors, files } = checkEnv({ rootDir });
  if (errors.length > 0) {
    console.error(`[env] 校验失败（扫描 ${files.length} 个文件）：`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`[env] 校验通过（扫描 ${files.length} 个文件）`);
}

// 仅直跑时需要（ESM 下 fileURLToPath 顶部已导入，避免未使用告警的占位引用）
void fileURLToPath;
void relative;
