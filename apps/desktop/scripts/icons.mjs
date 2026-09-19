#!/usr/bin/env node
/**
 * 生成桌面端图标集（`src-tauri/icons/`）——**换标只跑这一条命令**。
 *
 * 用法：`node scripts/icons.mjs`（在 apps/desktop 下）
 *
 * 源是品牌标的当前定稿：`docs/design/logo/` 里最新的那张（2026-09-19 换成了
 * `GPT生成.png` 的蓝色 KF 标）。生成交给 Tauri 自带的 `tauri icon`——它会出整套
 * （`icon.ico` 多尺寸给 Windows、`icon.icns`、`icon.png`、`Square*.png`、android/ios），
 * 比手写 ICO 打包器可靠，也保证与框架约定一致（此前那份手写的只出 ico + 几个 png）。
 *
 * 历史：更早的定稿是 `最终定稿.svg`（岚配色 + 白字形 K），当时用 sharp 栅格化；
 * 换成位图标之后 sharp 那条路不再适用（PNG 不需要栅格化）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const outDir = join(import.meta.dirname, "..", "src-tauri", "icons");

/** 品牌标候选源（按优先级）：当前定稿在前。 */
const SOURCES = ["GPT生成.png", "最终定稿.svg"].map((name) =>
  join(repoRoot, "docs", "design", "logo", name),
);

const source = SOURCES.find((path) => existsSync(path));
if (!source) {
  console.error(
    `找不到品牌标源文件，试过：\n${SOURCES.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(`用 ${source} 生成图标集 → ${outDir}`);
const result = spawnSync(
  "pnpm",
  ["exec", "tauri", "icon", source, "-o", outDir],
  {
    cwd: join(repoRoot, "apps", "desktop"),
    shell: process.platform === "win32",
    stdio: "inherit",
  },
);
if (result.status !== 0) {
  console.error(
    "tauri icon 失败（需要 tauri CLI：pnpm --filter @kenfutwork/desktop exec tauri --version）",
  );
  process.exit(result.status ?? 1);
}
console.log(
  "图标已更新：exe 资源图标 / 安装包向导图标 / 开始菜单与任务栏图标都吃这一份；" +
    "接着重跑 pnpm --filter @kenfutwork/desktop build 让安装包带上新图标。",
);
