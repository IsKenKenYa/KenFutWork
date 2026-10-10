import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const sourceOption = args.indexOf("--source-root");
const sourceArgs = sourceOption >= 0 ? args.splice(sourceOption, 2) : [];
// 上游逐字源码先过来源校验；第一方宿主与未登记文件仍遵守仓库 Biome 规则。
const verification = spawnSync(
  process.execPath,
  ["scripts/vendor-zcode.mjs", ...sourceArgs],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (verification.status !== 0) process.exit(verification.status ?? 1);
const inventory = JSON.parse(
  readFileSync(resolve(root, "docs/源码来源/ZCode源码清单.json"), "utf8"),
);
const upstream = new Set(inventory.records.map((record) => record.target));
const kimiInventory = JSON.parse(
  readFileSync(
    resolve(root, "packages/third-party/kimi-edit/来源清单.json"),
    "utf8",
  ),
);
for (const record of kimiInventory.records) {
  const target = `packages/third-party/kimi-edit/${record.target}`;
  const currentSha256 = createHash("sha256")
    .update(readFileSync(resolve(root, target)))
    .digest("hex");
  if (currentSha256 !== record.currentSha256)
    throw new Error(`Kimi 源码来源校验失败：${target}`);
  upstream.add(target);
}
const listing = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
);
if (listing.status !== 0) throw new Error("无法读取实际源码清单");
const files = [...new Set(listing.stdout.split("\0"))].filter((path) => {
  if (upstream.has(path) || !/\.(?:[cm]?js|tsx?|jsonc?)$/u.test(path))
    return false;
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
    [biomeBin, "check", ...batch, ...args],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) biomeFailed = true;
}
process.exit(biomeFailed ? 1 : 0);
