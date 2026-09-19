#!/usr/bin/env node
/**
 * 把刚打出来的安装包**收到仓库根目录**（用户口径：默认产物就在项目根，别埋在
 * `target/release/bundle/nsis/` 那种深层路径里）。构建由 `pnpm --filter @kenfutwork/desktop build`
 * 串起来：`tauri build && node scripts/collect-bundle.mjs`。
 *
 * 根目录只留**最新一份**：每次收的时候把同名的旧副本删掉，免得攒出好几个 69 MB 的文件。
 * 原始产物仍在 tauri 的 bundle 目录里（发布流水线要它就在那），这里只是多放一份顺手的位置。
 */

import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const bundleDir = join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
);

if (!existsSync(bundleDir)) {
  console.error(`[collect] 没找到安装包目录：${bundleDir}（先跑 tauri build）`);
  process.exit(1);
}

const candidates = readdirSync(bundleDir)
  .filter((name) => name.endsWith("-setup.exe"))
  .map((name) => join(bundleDir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (candidates.length === 0) {
  console.error(`[collect] ${bundleDir} 里没有 *-setup.exe`);
  process.exit(1);
}

const latest = candidates[0];
const target = join(repoRoot, latest.split(/[\\/]/).pop());

// 根目录只留最新一份：清掉旧的同名产物
for (const name of readdirSync(repoRoot)) {
  if (name.endsWith("-setup.exe") && join(repoRoot, name) !== target) {
    rmSync(join(repoRoot, name), { force: true });
    console.log(`[collect] 删掉根目录旧副本：${name}`);
  }
}

copyFileSync(latest, target);
const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(1);
console.log(`[collect] 安装包已在项目根：${target}（${sizeMb} MB，双击即装）`);
