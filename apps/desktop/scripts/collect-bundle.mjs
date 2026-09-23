#!/usr/bin/env node
/**
 * 把刚打出来的安装包**收到仓库根目录**（用户口径：默认产物就在项目根，别埋在
 * `target/release/bundle/…` 那种深层路径里）。构建由 `pnpm --filter @kenfutwork/desktop build`
 * 串起来：`tauri build && node scripts/collect-bundle.mjs`。
 *
 * 根目录只留**最新一份**：每次收的时候把同名的旧副本删掉，免得攒出好几个几十 MB 的文件。
 * 原始产物仍在 tauri 的 bundle 目录里（发布流水线要它就在那），这里只是多放一份顺手的位置。
 *
 * 按平台收不同产物：Windows 收 NSIS 的 `*-setup.exe`；macOS 的 DMG **不用** tauri 的
 * bundler（它靠 AppleScript 驱动 Finder 走 UI，无头/受限环境必挂），而是这里直接
 * `hdiutil create` 把 `bundle/macos/KenFutWork.app` 打成镜像（2026-09-23，见
 * scripts/package-mac.mjs）。Linux 没有产物，静默跳过。
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
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
  // tauri 的 dmg bundler 依赖 AppleScript（Finder 自动化），无头环境跑不了：
  // 这里用 hdiutil 直接生成，镜像根上就是 .app（挂载后拖入 Applications 即装）。
  const appDir = join(bundleBase, "macos");
  if (!existsSync(join(appDir, "KenFutWork.app"))) {
    console.error(`[collect] 没找到应用包：${appDir}（先跑 tauri build）`);
    process.exit(1);
  }
  // tauri 的默认 ad-hoc 签名不封 Resources（verify 报 "code has no resources"）——
  // 深签一遍把 Resources/seal 补上（ad-hoc 身份，本机可开；对外分发需 Developer ID + 公证）。
  const resign = spawnSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", join(appDir, "KenFutWork.app")],
    { stdio: "inherit" },
  );
  if (resign.status !== 0) {
    console.error("[collect] 深签名失败");
    process.exit(resign.status ?? 1);
  }
  const version = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "src-tauri", "tauri.conf.json"),
      "utf8",
    ),
  ).version;
  const dmgName = `KenFutWork_${version}_${process.arch}.dmg`;
  const dmgPath = join(repoRoot, dmgName);
  rmSync(dmgPath, { force: true });
  const hdiutil = spawnSync(
    "/usr/bin/hdiutil",
    [
      // 显式给足尺寸：hdiutil 对自动估大小会算漏（缺一个文件就 ENOSPC 中途失败）
      "create",
      "-volname",
      "KenFutWork",
      "-size",
      "2g",
      "-fs",
      "HFS+",
      "-srcfolder",
      appDir,
      "-ov",
      "-format",
      "UDZO",
      dmgPath,
    ],
    { stdio: "inherit" },
  );
  if (hdiutil.status !== 0) {
    console.error("[collect] hdiutil 创建 DMG 失败");
    process.exit(hdiutil.status ?? 1);
  }
  const sizeMb = (statSync(dmgPath).size / 1024 / 1024).toFixed(1);
  console.log(
    `[collect] DMG 已在项目根：${dmgPath}（${sizeMb} MB，挂载后拖入 Applications）`,
  );
} else {
  console.log("[collect] 该平台没有安装包产物，跳过收集。");
}
