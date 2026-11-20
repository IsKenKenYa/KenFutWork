import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

/**
 * 第三方移植目录不参与第一方 lint：这些文件来自上游（ZCode 为 Apache-2.0），
 * 保持上游原样便于对照，格式化会制造无意义的差异。
 *
 * `apps/web/src/components/workbench/zcode/host/` 是本仓自写的宿主适配层，
 * 仍按第一方规则检查，所以只排除该目录下除 `host/` 以外的部分。
 */
const ZCODE_UI_ROOT = "apps/web/src/components/workbench/zcode/";
const ZCODE_UI_HOST = `${ZCODE_UI_ROOT}host/`;
/** 上下文分析面板的 vendored 上游（dsh-context），同样保持原字节。 */
const CONTEXT_INSIGHTS_VENDOR = "packages/context-insights-ui/vendor/";
/** 移植到服务端目录的三个上游文件，同样保持原字节。 */
const UPSTREAM_FILES = new Set([
  "apps/server/src/features/model-providers/zcode-model-config-rules.json",
  "apps/server/src/features/settings/zcode-command-expansion.ts",
  "apps/server/src/features/skills/skill-document-body.ts",
]);
const isThirdParty = (path) =>
  (path.startsWith(ZCODE_UI_ROOT) && !path.startsWith(ZCODE_UI_HOST)) ||
  path.startsWith(CONTEXT_INSIGHTS_VENDOR) ||
  /^packages\/zcode-[^/]+\//u.test(path) ||
  UPSTREAM_FILES.has(path);

// Kimi 精确编辑的移植副本仍按清单核对字节，核对通过后同样不参与第一方 lint。
const kimiInventory = JSON.parse(
  readFileSync(
    resolve(root, "packages/third-party/kimi-edit/来源清单.json"),
    "utf8",
  ),
);
const kimiTargets = new Set();
for (const record of kimiInventory.records) {
  const target = `packages/third-party/kimi-edit/${record.target}`;
  const currentSha256 = createHash("sha256")
    .update(readFileSync(resolve(root, target)))
    .digest("hex");
  if (currentSha256 !== record.currentSha256)
    throw new Error(`Kimi 源码来源校验失败：${target}`);
  kimiTargets.add(target);
}

const listing = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
if (listing.status !== 0) throw new Error("无法读取实际源码清单");
const files = [...new Set(listing.stdout.split("\0"))].filter((path) => {
  if (isThirdParty(path) || kimiTargets.has(path)) return false;
  if (!/\.(?:[cm]?js|tsx?|jsonc?)$/u.test(path)) return false;
  try {
    return statSync(resolve(root, path)).isFile();
  } catch {
    return false;
  }
});
/**
 * biome 用 **node 直跑它的 JS 入口**，并把文件列表分批传参——两条都是 Windows 上的
 * 硬约束（2026-10-09 实测，此前 `pnpm lint` 在这里静默退 1，连 biome 都没跑起来）：
 * - `spawnSync("pnpm", …)` 在 Windows 上没有 shell 时解析不到 `pnpm.CMD`（Node ≥20
 *   起 .cmd 不再可直接 spawn）→ ENOENT；
 * - 1375 条路径合计 6.6 万字符，一次传参超过 CreateProcess 的命令行上限（约 32k）同样失败。
 * 分批后每批各打各的摘要，任一批非零即整体失败。
 */
const biomeBin = createRequire(import.meta.url).resolve(
  "@biomejs/biome/bin/biome",
);
const BATCH_SIZE = 300;
let biomeFailed = false;
for (let index = 0; index < Math.max(files.length, 1); index += BATCH_SIZE) {
  const batch = files.slice(index, index + BATCH_SIZE);
  const result = spawnSync(
    process.execPath,
    // biome 默认只打 20 条诊断，且把「超出上限、其余已截断」自己也记成 error——
    // 存量 413 条 warning 足以让全量 lint 恒红，真错反而被这条噪音顶掉。
    // 放开上限后 warning 照报不拦路，退出码只由真 error（format / parse）决定。
    [biomeBin, "check", ...batch, "--max-diagnostics=none", ...args],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) biomeFailed = true;
}
process.exit(biomeFailed ? 1 : 0);
