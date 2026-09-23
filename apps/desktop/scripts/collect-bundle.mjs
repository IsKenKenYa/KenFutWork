#!/usr/bin/env node
/**
 * 把刚打出来的安装包**收到仓库根目录**（用户口径：默认产物就在项目根，别埋在
 * `target/release/bundle/…` 那种深层路径里）。构建由 `pnpm --filter @kenfutwork/desktop build`
 * 串起来：`tauri build && node scripts/collect-bundle.mjs`。
 *
 * 根目录只留**最新一份**：每次收的时候把同名的旧副本删掉，免得攒出好几个几十 MB 的文件。
 * 原始产物仍在 tauri 的 bundle 目录里（发布流水线要它就在那），这里只是多放一份顺手的位置。
 *
 * 按平台收不同产物：Windows 收 NSIS 的 `*-setup.exe`；macOS 收 DMG 的 `*.dmg`
 * （2026-09-23 起 mac 打包线可用，见 scripts/package-mac.mjs）。Linux 没有产物，静默跳过。
 */

import {
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const bundleBase = join(
  repoRoot,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
);

function collectLatest({ dir, suffix, doneMessage }) {
  if (!existsSync(dir)) {
    console.error(`[collect] 没找到产物目录：${dir}（先跑 tauri build）`);
    process.exit(1);
  }
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) {
    console.error(`[collect] ${dir} 里没有 *${suffix}`);
    process.exit(1);
  }
  const latest = candidates[0];
  const target = join(repoRoot, latest.split(/[\\/]/).pop());
  // 根目录只留最新一份：清掉旧的同名产物
  for (const name of readdirSync(repoRoot)) {
    if (name.endsWith(suffix) && join(repoRoot, name) !== target) {
      rmSync(join(repoRoot, name), { force: true });
      console.log(`[collect] 删掉根目录旧副本：${name}`);
    }
  }
  copyFileSync(latest, target);
  const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`[collect] ${doneMessage}：${target}（${sizeMb} MB）`);
}

if (process.platform === "win32") {
  collectLatest({
    dir: join(bundleBase, "nsis"),
    suffix: "-setup.exe",
    doneMessage: "安装包已在项目根（双击即装）",
  });
} else if (process.platform === "darwin") {
  collectLatest({
    dir: join(bundleBase, "dmg"),
    suffix: ".dmg",
    doneMessage: "DMG 已在项目根（双击挂载后拖入 Applications）",
  });
} else {
  console.log("[collect] 该平台没有安装包产物，跳过收集。");
}
