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
  <rect x="8" y="12" width="32" height="32" rx="8" ry="8" fill="#ffffff" stroke="#e2e9f7"/>
  <image href="mark" x="13" y="17" width="22" height="22" preserveAspectRatio="xMidYMid meet"/>
  <text x="45" y="36" font-family="${FONT}, sans-serif" font-size="17" font-weight="600" fill="${INK}">KenFutWork</text>
  <rect x="0" y="55" width="150" height="2" fill="url(#line)"/>
</svg>`;

/** 侧边图：164×314，白底 + 圆角卡片（径向/线性淡蓝）+ 大圆角图标块 + 字标 + 底部细线。 */
const sidebarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314">
  <defs>
    <linearGradient id="card" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e8f0ff"/>
    </linearGradient>
    <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#1c2f74"/><stop offset="0.45" stop-color="#2c4fcb"/><stop offset="1" stop-color="#5c82ec"/>
    </linearGradient>
  </defs>
  <rect width="164" height="314" fill="#ffffff"/>
  <!-- 圆角卡片：一点点圆角（用户口径） -->
  <rect x="10" y="58" width="144" height="198" rx="12" ry="12" fill="url(#card)" stroke="#e2e9f7"/>
  <!-- 图标：白底圆角块（22% 圆角，与桌面图标同一套） -->
  <rect x="54" y="96" width="56" height="56" rx="13" ry="13" fill="#ffffff" stroke="#e2e9f7"/>
  <image href="mark" x="63" y="105" width="38" height="38" preserveAspectRatio="xMidYMid meet"/>
  <text x="82" y="184" text-anchor="middle" font-family="${FONT}, sans-serif" font-size="18" font-weight="600" fill="${BLUE}">KenFutWork</text>
  <text x="82" y="206" text-anchor="middle" font-family="${FONT}, sans-serif" font-size="11" fill="#7b87a8">BYOK 本地 AI 工作台</text>
  <rect x="0" y="311" width="164" height="3" fill="url(#line)"/>
</svg>`;

/** 把 logo-mark.png 以 data URI 内联进 SVG（librsvg 读外部文件不可靠）。 */
const markUri = `data:image/png;base64,${(
  await import("node:fs")
).readFileSync(markPath).toString("base64")}`;

/**
 * 出图尺寸：**侧边图按 1.5× 出**。
 *
 * 为什么：向导（ManifestPerMonitorV2）在 150% 缩放的屏幕上会把侧边图**放大 1.5 倍**再画，
 * 拿 164×314 的原图上去就是糊的（用户口径「分辨率太低」）。按 4× 出后
 * MUI 会把它缩到侧边栏区域（超采样，任何 DPI 都清晰）；页头图 MUI **不缩放**，仍按 150×57 出（给大了会被裁）。
 */
const SIDEBAR_SCALE = 4;

for (const [name, svg, width, height] of [
  ["installer-header.bmp", headerSvg, 150, 57],
  [
    "installer-sidebar.bmp",
    sidebarSvg,
    Math.round(164 * SIDEBAR_SCALE),
    Math.round(314 * SIDEBAR_SCALE),
  ],
]) {
  // 4× 超采样：先按 4 倍画再降采样，文字与圆角边缘才不糊（用户口径「分辨率好低」）
  const SS = 4;
  const png = await sharp(
    Buffer.from(svg.replaceAll("href=\"mark\"", `href="${markUri}"`)),
    { density: 72 * SS },
  )
    .resize(width * SS, height * SS)
    .resize(width, height)
    .ensureAlpha()
    .png()
    .toBuffer();
  const pngPath = join(outDir, name.replace(/\.bmp$/, ".png"));
  writeFileSync(pngPath, png);
  console.log(`已生成 ${pngPath}（${width}×${height}）——BMP 由 convert-art-to-bmp.ps1 转换`);
}
