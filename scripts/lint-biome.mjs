import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// 上游逐字源码先过来源校验；第一方宿主与未登记文件仍遵守仓库 Biome 规则。
const verification = spawnSync(process.execPath, ["scripts/vendor-zcode.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (verification.status !== 0) process.exit(verification.status ?? 1);
const inventory = JSON.parse(
  readFileSync(resolve(root, "docs/源码来源/ZCode源码清单.json"), "utf8"),
);
const upstream = new Set(inventory.records.map((record) => record.target));
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
const result = spawnSync(
  "pnpm",
  ["exec", "biome", "check", ...files, ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
