#!/usr/bin/env node
/**
 * 生成安装向导的**品牌图**（用户口径：默认那套太像上世纪，想要小清新、简洁大方）。
 *
 * NSIS 只认 **24 位 BMP**，而 sharp 不能写 BMP——所以这里用 sharp 渲染 SVG 到原始像素，
 * 再手写 BMP 头（自下而上、每行 4 字节对齐）。两张图：
 *   - `installer-header.bmp` 150×57：内页页头（MUI 画在右上角），白底 + 标记 + 字标 + 底部一条品牌细线
 *   - `installer-sidebar.bmp` 164×314：欢迎/完成页的左侧图，极浅竖向渐变 + 标记 + 字标
 *
 * 用法：`node scripts/installer-art.mjs`（在 apps/desktop 下，需要 sharp——从 apps/server 解析）。
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const outDir = join(import.meta.dirname, "..", "src-tauri");
const markPath = join(repoRoot, "apps", "web", "public", "logo-mark.png");

const require = createRequire(join(repoRoot, "apps", "server", "package.json"));
const sharp = require("sharp");

const INK = "#1c2f74";
const BLUE = "#2c4fcb";
const FONT = "Segoe UI";

/** 页头：150×57，白底 + 标记 + 字标 + 底部品牌细线。 */
const headerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57">
  <defs>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1c2f74"/><stop offset="0.45" stop-color="#2c4fcb"/><stop offset="1" stop-color="#5c82ec"/>
    </linearGradient>
  </defs>
  <rect width="150" height="57" fill="#ffffff"/>
  <image href="mark" x="10" y="14" width="28" height="28" preserveAspectRatio="xMidYMid meet"/>
  <text x="45" y="36" font-family="${FONT}, sans-serif" font-size="17" font-weight="600" fill="${INK}">KenFutWork</text>
  <rect x="0" y="55" width="150" height="2" fill="url(#line)"/>
</svg>`;

/** 侧边图：164×314，极浅竖向渐变 + 标记 + 字标 + 底部细线。 */
const sidebarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef3ff"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1c2f74"/><stop offset="0.45" stop-color="#2c4fcb"/><stop offset="1" stop-color="#5c82ec"/>
    </linearGradient>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <image href="mark" x="54" y="104" width="56" height="56" preserveAspectRatio="xMidYMid meet"/>
  <text x="82" y="196" text-anchor="middle" font-family="${FONT}, sans-serif" font-size="19" font-weight="600" fill="${BLUE}">KenFutWork</text>
  <rect x="0" y="311" width="164" height="3" fill="url(#line)"/>
</svg>`;

/** 把 logo-mark.png 以 data URI 内联进 SVG（librsvg 读外部文件不可靠）。 */
const markUri = `data:image/png;base64,${(
  await import("node:fs")
).readFileSync(markPath).toString("base64")}`;

for (const [name, svg, width, height] of [
  ["installer-header.bmp", headerSvg, 150, 57],
  ["installer-sidebar.bmp", sidebarSvg, 164, 314],
]) {
  const png = await sharp(
    Buffer.from(svg.replaceAll("href=\"mark\"", `href="${markUri}"`)),
  )
    .resize(width, height)
    .ensureAlpha()
    .png()
    .toBuffer();
  const pngPath = join(outDir, name.replace(/\.bmp$/, ".png"));
  writeFileSync(pngPath, png);
  console.log(`已生成 ${pngPath}（${width}×${height}）——BMP 由 convert-art-to-bmp.ps1 转换`);
}
