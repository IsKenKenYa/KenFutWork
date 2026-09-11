#!/usr/bin/env node
/**
 * docs 机械校验（属主：`docs/README.md` 治理规则 6）
 *
 * 为什么存在：文档治理规则（单源、决策 ID、冻结区、新文档入图）此前只靠人肉自觉，
 * 每轮改文档都会重新漂移。本脚本把规则变成可执行断言，接入仓库门禁（`pnpm test:docs`）。
 *
 * 覆盖六条：
 *   1) docs 内相对链接与锚点可解析（外部 http(s)/mailto 跳过，HTML 注释与代码块内跳过）；
 *   2) 冻结区（<!-- frozen:start --> ~ <!-- frozen:end -->）SHA-256 与 docs/frozen-lock.json 一致；
 *   3) 文档中出现的决策 ID（DEC-* / FORM-*）均已登记进 docs/README.md「决策 ID 登记表」；
 *   4) docs/**\/*.md 均已登记进文档地图（`Loomic原版文档/`、`decisions/ADR-*.md`、README 自身豁免）；
 *   5) 全仓库只有《改造计划》§4.2 一处以表头 `ctx key` 定义 key 清单；
 *   6) `docs/decisions/` 下 ADR 文件名符合 `ADR-<YYYYMMDD>-<ID>.md`。
 *
 * 用法：
 *   node scripts/check-docs.mjs                # 校验，失败退出码 1
 *   node scripts/check-docs.mjs --update-lock  # 同步冻结区锁文件（改冻结区后必须显式执行）
 *
 * 维护提示：新增校验规则时，先改 docs/README.md 治理规则 6，再改本文件，保持规则文本与实现一一对应。
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FROZEN_START = "<!-- frozen:start -->";
const FROZEN_END = "<!-- frozen:end -->";
const LOCK_FILE = "docs/frozen-lock.json";
const MAP_FILE = "docs/README.md";
/** 文档地图自身不入图；原版历史文档整目录豁免；ADR 由 docs/decisions/README.md 索引，不逐个入图。 */
const MAP_EXCLUDE_FILES = new Set(["docs/README.md"]);
const MAP_EXCLUDE_PREFIXES = ["docs/Loomic原版文档/"];
const MAP_EXCLUDE_PATTERN = /^docs\/decisions\/ADR-/;
/**
 * 冻结扫描豁免：`docs/README.md` 的治理规则 3 必须把冻结标记写成字面量来定义规则，
 * 因而天然含有这两个标记，不能据此判定「自己也冻结」。
 */
const FROZEN_SCAN_EXCLUDE = new Set(["docs/README.md"]);
const DECISION_ID_PATTERN = /\b(DEC|FORM)-(\d+)\b/g;
const ADR_NAME_PATTERN = /^ADR-(\d{8})-(DEC|FORM)-(\d+)\.md$/;
/** 唯一允许定义 ctx key 清单的文档。 */
const CTX_KEY_TABLE_OWNER = "docs/tech/改造计划.md";
const CTX_KEY_HEADER_CELL = "ctx key";

const docsDir = "docs";

function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** 统一换行，避免 autocrlf 导致的 hash 漂移。 */
function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

/** GitHub 风格 heading slug，用于校验同文档锚点。 */
export function slugifyHeading(heading) {
  return heading
    .trim()
    .replace(/`/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

async function listMarkdownFiles(rootDir) {
  const result = [];
  async function walk(relDir) {
    const absDir = path.join(rootDir, relDir);
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = toPosix(path.join(relDir, entry.name));
      if (entry.isDirectory()) {
        await walk(rel);
      } else if (entry.name.endsWith(".md")) {
        result.push(rel);
      }
    }
  }
  await walk(docsDir);
  return result.sort();
}

/** 去掉 HTML 注释与围栏代码块，避免其中的示例链接/ID 被误判。 */
function stripNoise(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/^```[\s\S]*?^```/gm, "");
}

function collectHeadings(text) {
  const slugs = new Set();
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.*?)\s*$/);
    if (match) {
      slugs.add(slugifyHeading(match[1]));
    }
  }
  return slugs;
}

function collectLinkTargets(text) {
  const targets = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    targets.push(match[1].trim());
    match = pattern.exec(text);
  }
  return targets;
}

function isExternalTarget(target) {
  return /^(https?:|mailto:|tel:|data:)/i.test(target);
}

async function checkLinks(file, text, rootDir) {
  const errors = [];
  const cleaned = stripNoise(text);
  const ownSlugs = collectHeadings(text);
  for (const rawTarget of collectLinkTargets(cleaned)) {
    // 去掉可选 title：`path "标题"`
    const target = rawTarget.split(/\s+"/)[0].replace(/^<|>$/g, "");
    if (target === "" || isExternalTarget(target)) {
      continue;
    }
    const [rawPath, rawAnchor] = target.split("#");
    const hasPath = rawPath !== undefined && rawPath !== "";
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(rawPath ?? "");
    } catch {
      errors.push(`${file}: 链接路径转义非法 → ${rawTarget}`);
      continue;
    }
    const absTarget = hasPath
      ? path.resolve(rootDir, path.dirname(file), decodedPath)
      : path.resolve(rootDir, file);

    if (hasPath) {
      if (!(await fileExists(absTarget))) {
        errors.push(
          `${file}: 链接目标不存在 → ${rawTarget}（解析为 ${toPosix(path.relative(rootDir, absTarget))}）`,
        );
        continue;
      }
    }
    if (rawAnchor !== undefined && rawAnchor !== "") {
      const slugs = hasPath
        ? collectHeadings(await readFile(absTarget, "utf8"))
        : ownSlugs;
      const anchor = slugifyHeading(decodeURIComponent(rawAnchor));
      if (!slugs.has(anchor)) {
        errors.push(`${file}: 锚点不存在 → ${rawTarget}（slug: ${anchor}）`);
      }
    }
  }
  return errors;
}

async function fileExists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

function hashFrozenBody(text) {
  const startIdx = text.indexOf(FROZEN_START);
  const endIdx = text.indexOf(FROZEN_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }
  const body = text.slice(startIdx + FROZEN_START.length, endIdx);
  return createHash("sha256").update(body, "utf8").digest("hex");
}

async function readLock(rootDir) {
  try {
    return JSON.parse(await readFile(path.join(rootDir, LOCK_FILE), "utf8"));
  } catch {
    return { frozen: [] };
  }
}

/** 解析 docs/README.md 中「决策 ID 登记表」的行首 ID。 */
function collectRegisteredDecisionIds(mapText) {
  const ids = new Set();
  for (const line of mapText.split("\n")) {
    const match = line.match(/^\|\s*`((?:DEC|FORM)-\d+)`\s*\|/);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function isMappedInDocMap(docMapText, file) {
  // 地图用「相对 docs/ 的路径」登记（如 `tech/改造计划.md`），同时容忍带 docs/ 前缀的写法。
  const relative = file.startsWith(`${docsDir}/`)
    ? file.slice(docsDir.length + 1)
    : file;
  return (
    docMapText.includes(`\`${relative}\``) || docMapText.includes(`\`${file}\``)
  );
}

/** 表格 header 行是否含指定单元格（精确匹配，避免误判 `dsh ctx key`）。 */
function tableHeaderHasCell(line, cell) {
  if (!line.trimStart().startsWith("|")) {
    return false;
  }
  return line
    .split("|")
    .slice(1, -1)
    .some((part) => part.trim() === cell);
}

export async function checkDocs({ rootDir }) {
  const errors = [];
  const files = await listMarkdownFiles(rootDir);
  const docMapRaw = await readFile(path.join(rootDir, MAP_FILE), "utf8");
  const docMapText = stripNoise(docMapRaw);
  const registeredIds = collectRegisteredDecisionIds(docMapRaw);
  const lock = await readLock(rootDir);
  const caches = new Map();
  const load = async (rel) => {
    if (!caches.has(rel)) {
      caches.set(
        rel,
        normalize(await readFile(path.join(rootDir, rel), "utf8")),
      );
    }
    return caches.get(rel);
  };

  // 1) 链接与锚点
  for (const file of files) {
    const text = await load(file);
    errors.push(...(await checkLinks(file, text, rootDir)));
  }

  // 2) 冻结区 hash
  const frozenEntries = Array.isArray(lock.frozen) ? lock.frozen : [];
  for (const entry of frozenEntries) {
    const text = await load(entry.file);
    const actual = hashFrozenBody(text);
    if (actual === null) {
      errors.push(
        `${entry.file}: 缺少冻结标记（${FROZEN_START} / ${FROZEN_END}），但被 ${LOCK_FILE} 登记为冻结区`,
      );
      continue;
    }
    if (actual !== entry.sha256) {
      errors.push(
        `${entry.file}: 冻结区被修改（约定 ${entry.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）。` +
          `冻结区禁止编辑；确需变更请在 PR 说明理由并执行 node scripts/check-docs.mjs --update-lock`,
      );
    }
  }
  for (const file of files) {
    if (FROZEN_SCAN_EXCLUDE.has(file)) {
      continue;
    }
    const text = await load(file);
    if (
      text.includes(FROZEN_START) &&
      !frozenEntries.some((e) => e.file === file)
    ) {
      errors.push(`${file}: 有冻结标记但未登记进 ${LOCK_FILE}`);
    }
  }

  // 3) 决策 ID 必须已登记
  for (const file of files) {
    const text = stripNoise(await load(file));
    for (const match of text.matchAll(DECISION_ID_PATTERN)) {
      const id = match[0];
      if (!registeredIds.has(id)) {
        errors.push(
          `${file}: 决策 ID \`${id}\` 未在 ${MAP_FILE}「决策 ID 登记表」登记（新增决策必须先在登记表登记）`,
        );
      }
    }
  }

  // 4) 每个 docs markdown 必须入图
  for (const file of files) {
    if (
      MAP_EXCLUDE_FILES.has(file) ||
      MAP_EXCLUDE_PREFIXES.some((p) => file.startsWith(p)) ||
      MAP_EXCLUDE_PATTERN.test(file)
    ) {
      continue;
    }
    if (!isMappedInDocMap(docMapText, file)) {
      errors.push(`${file}: 未登记进 ${MAP_FILE} 文档地图（治理规则 5）`);
    }
  }

  // 5) ctx key 清单只允许一处
  const ctxKeyTables = [];
  for (const file of files) {
    const text = stripNoise(await load(file));
    for (const line of text.split("\n")) {
      if (tableHeaderHasCell(line, CTX_KEY_HEADER_CELL)) {
        ctxKeyTables.push(file);
        break;
      }
    }
  }
  if (ctxKeyTables.length !== 1 || ctxKeyTables[0] !== CTX_KEY_TABLE_OWNER) {
    errors.push(
      `ctx key 清单表只允许出现在 ${CTX_KEY_TABLE_OWNER}，实际出现在：[${ctxKeyTables.join(", ") || "无"}]`,
    );
  }

  // 6) ADR 文件命名
  for (const file of files) {
    const name = path.posix.basename(file);
    if (
      file.startsWith("docs/decisions/") &&
      name.startsWith("ADR-") &&
      !ADR_NAME_PATTERN.test(name)
    ) {
      errors.push(
        `${file}: ADR 命名必须为 ADR-<YYYYMMDD>-<ID>.md（见 docs/decisions/README.md）`,
      );
    }
  }

  return { errors, files };
}

export async function updateFrozenLock({ rootDir }) {
  const lock = await readLock(rootDir);
  const entries = [];
  for (const file of await listMarkdownFiles(rootDir)) {
    if (FROZEN_SCAN_EXCLUDE.has(file)) {
      continue;
    }
    const text = normalize(await readFile(path.join(rootDir, file), "utf8"));
    const sha256 = hashFrozenBody(text);
    if (sha256 !== null) {
      entries.push({ file, sha256 });
    }
  }
  const next = {
    $comment:
      "冻结区锁文件，由 scripts/check-docs.mjs 读写。变更冻结区必须在 PR 说明理由并执行 node scripts/check-docs.mjs --update-lock。",
    frozen: entries,
  };
  await writeFile(
    path.join(rootDir, LOCK_FILE),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  const stale = (Array.isArray(lock.frozen) ? lock.frozen : []).filter(
    (old) => !entries.some((e) => e.file === old.file),
  );
  return { updated: entries, removed: stale.map((e) => e.file) };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  if (process.argv.includes("--update-lock")) {
    const { updated, removed } = await updateFrozenLock({ rootDir });
    console.log(`[docs] 已同步冻结区锁文件 ${LOCK_FILE}`);
    for (const entry of updated) {
      console.log(`  - ${entry.file}  ${entry.sha256.slice(0, 12)}…`);
    }
    for (const file of removed) {
      console.log(`  - 移除已无冻结标记的登记：${file}`);
    }
    process.exit(0);
  }

  const { errors, files } = await checkDocs({ rootDir });
  if (errors.length === 0) {
    console.log(`[docs] 校验通过（${files.length} 个 markdown 文件）`);
    process.exit(0);
  }
  console.error(`[docs] 校验失败，共 ${errors.length} 项：`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}
