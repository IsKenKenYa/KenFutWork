#!/usr/bin/env node
/**
 * 生成桌面端图标集（`src-tauri/icons/`）：多尺寸 `icon.ico` + `icon.png`。
 *
 * 源是品牌 logo 的**唯一权威源** `docs/design/logo/最终定稿.svg`——图标不该是
 * 另画一份的贴图（此前这里是占位绿方块，安装包/任务栏/开始菜单全是它，
 * 用户 2026-09-17 要求换上正式标）。
 *
 * 用法：`node scripts/icons.mjs`（在 apps/desktop 下）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const sourceSvg = join(repoRoot, "docs", "design", "logo", "最终定稿.svg");
const iconsDir = join(import.meta.dirname, "..", "src-tauri", "icons");

// sharp 是 apps/server 的依赖（图片生成 provider 用它）。按它的包位置解析，
// 免得给桌面壳再加一个原生依赖——打包脚本只在构建期跑一次。
const require = createRequire(join(repoRoot, "apps", "server", "package.json"));
const sharp = require("sharp");

/** ICO 里的尺寸：小尺寸给向导/标题栏，大尺寸给资源管理器与任务栏。 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 打成 PNG-in-ICO（Vista 起支持，NSIS 3 与 tauri-build 都吃这种）。 */
function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at); // 256 记作 0
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // 调色板
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

const svg = readFileSync(sourceSvg);
/** 栅格化：先按高 DPI 渲染再由 sharp 缩到目标尺寸，小尺寸下比直接渲染更锐。 */
const render = (size) =>
  sharp(svg, { density: 512 })
    .resize(size, size, { fit: "contain" })
    .png({ compressionLevel: 9 })
    .toBuffer();

const entries = [];
for (const size of ICO_SIZES) {
  entries.push({ size, data: await render(size) });
}
writeFileSync(join(iconsDir, "icon.ico"), packIco(entries));
writeFileSync(join(iconsDir, "icon.png"), await render(512));
for (const [size, name] of [
  [32, "32x32.png"],
  [128, "128x128.png"],
  [256, "128x128@2x.png"],
]) {
  writeFileSync(join(iconsDir, name), await render(size));
}

console.log(
  `已生成图标：icon.ico（${ICO_SIZES.join("/")}）+ icon.png(512) + 32x32/128x128/128x128@2x，源 ${sourceSvg}`,
);
