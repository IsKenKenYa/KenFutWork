#!/usr/bin/env node
/**
 * 生成桌面端图标集 + 应用内品牌图（**换标只跑这一条命令**）。
 *
 * 用法：`node scripts/icons.mjs`（在 apps/desktop 下）
 *
 * 两步：
 * 1. **合成应用图标**：源标（`docs/design/logo/GPT生成.png`，蓝 KF）叠在**白色圆角贴片**上
 *    —— 用户口径「图标后面加上白色背景，圆角还是之前的小米图标同版圆角」：圆角取 22%，
 *    与上一版（岚配色圆角方块）的 clip 半径一致（112/512 ≈ 21.9%）。
 *    合成结果同时落到 `docs/design/logo/应用图标-白底圆角.png`（可入库的定稿）、
 *    `apps/web/public/logo.png`（应用内品牌图）与 `apps/web/public/app-icon.png`（启动页等）。
 * 2. **出整套平台图标**：交给 Tauri 自带的 `tauri icon`（ico、icns、png、Square 系列、android、ios），
 *    比手写 ICO 打包器可靠，也保证与框架约定一致。
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const iconsDir = join(import.meta.dirname, "..", "src-tauri", "icons");
const publicDir = join(repoRoot, "apps", "web", "public");
const designDir = join(repoRoot, "docs", "design", "logo");

// sharp 是 apps/server 的依赖（图片生成 provider 用它）；按它的包位置解析，不给桌面壳加依赖
const require = createRequire(join(repoRoot, "apps", "server", "package.json"));
const sharp = require("sharp");

/** 品牌标候选源（按优先级）：当前定稿在前。 */
const SOURCES = ["GPT生成.png", "最终定稿.svg"].map((name) =>
  join(designDir, name),
);
const source = SOURCES.find((path) => existsSync(path));
if (!source) {
  console.error(`找不到品牌标源文件，试过：\n${SOURCES.join("\n")}`);
  process.exit(1);
}

/** 白底圆角贴片参数：1024 画布、圆角 22%（≈上一版方块图标）、标占 86%（trim 掉透明边距后再留一圈白边——用户口径「还是要留点边距」）。 */
const CANVAS = 1024;
const RADIUS = Math.round(CANVAS * 0.22);
const MARK = Math.round(CANVAS * 0.86);

const tile = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}">
     <rect width="${CANVAS}" height="${CANVAS}" rx="${RADIUS}" ry="${RADIUS}" fill="#FFFFFF"/>
   </svg>`,
);
/**
 * 源图自带**透明边距**（GPT 生成的 1254×1254 里字形只占中间一块）。不裁掉它，字形在白底块里
 * 只占 ~60%，桌面上看着就"小一圈"（用户口径：桌面显示的和预览的不一样）。
 * 先 trim 再缩放，字形才真正顶满。
 */
const trimmedSource = await sharp(source).trim({ threshold: 1 }).png().toBuffer();
const mark = await sharp(trimmedSource)
  .resize(MARK, MARK, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();
const composed = await sharp(tile)
  .composite([{ input: mark, gravity: "center" }])
  .png({ compressionLevel: 9 })
  .toBuffer();

const composedPath = join(designDir, "应用图标-白底圆角.png");
await sharp(composed).toFile(composedPath);
copyFileSync(composedPath, join(publicDir, "logo.png"));
copyFileSync(composedPath, join(publicDir, "app-icon.png"));
console.log(
  `应用图标已合成（白底圆角 ${RADIUS}/${CANVAS}）：${composedPath}\n` +
    `  同时写入 apps/web/public/logo.png 与 app-icon.png`,
);

console.log(`再用 tauri icon 出整套平台图标 → ${iconsDir}`);
// 直接用 node 跑 Tauri CLI：不经过 pnpm / PATH（2026-09-19 真机上机器级 PATH 被别的软件改坏过，
// 那会儿 `pnpm`、`powershell` 这些靠 PATH 解析的启动器全都失灵，脚本得能扛住）
const result = spawnSync(
  process.execPath,
  [
    join(
      repoRoot,
      "apps",
      "desktop",
      "node_modules",
      "@tauri-apps",
      "cli",
      "tauri.js",
    ),
    "icon",
    composedPath,
    "-o",
    iconsDir,
  ],
  { cwd: join(repoRoot, "apps", "desktop"), stdio: "inherit" },
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
