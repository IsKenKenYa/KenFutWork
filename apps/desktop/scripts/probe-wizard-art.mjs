#!/usr/bin/env node
/**
 * 打包前先看「用户实际会看到的向导品牌图」：把**当前**的 installer-header.bmp / installer-sidebar.bmp
 * 编进一个探针安装器，起窗口、抓屏到 PNG（会短暂弹两个窗口，抓完自动关掉）。
 *
 * 为什么不直接跑正式安装包：正式 `setup.exe` 一启动就弹 UAC，自动化点不到提权框
 * （实测 `Start-Process` 报 “The operation was canceled by the user”）。探针与正式包共用同一套
 * NSIS/MUI 设置（同 `MUI_HEADERIMAGE*`、同 `ManifestDPIAware` / `ManifestDPIAwareness`），
 * 只把 `RequestExecutionLevel` 降成 `user` —— 于是「位图被 StretchBlt 拉到 DPI 缩放后的控件尺寸」
 * 这条最容易出错的链路可以原样复现（2026-09-19「图还是糊」的根因，见 `docs/未做需求.md` §三十八）。
 *
 * 用法：`pnpm --filter @kenfutwork/desktop verify:wizard-art`
 * 产物：`%TEMP%\kfw-wizard-probe\页头.png`、`侧边.png`（窗口原始像素，未缩放）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const srcTauri = join(here, "..", "src-tauri");
const outDir = join(tmpdir(), "kfw-wizard-probe");
const makensis = join(
  homedir(),
  "AppData",
  "Local",
  "tauri",
  "NSIS",
  "makensis.exe",
);
const powershell = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const headerBmp = join(srcTauri, "installer-header.bmp");
const sidebarBmp = join(srcTauri, "installer-sidebar.bmp");

if (!existsSync(makensis)) {
  console.error(
    `找不到 makensis：${makensis}\n` +
      "先跑一次打包（pnpm --filter @kenfutwork/desktop build）让 Tauri 把 NSIS 下载下来。",
  );
  process.exit(1);
}
for (const bmp of [headerBmp, sidebarBmp]) {
  if (!existsSync(bmp)) {
    console.error(
      `缺少 ${bmp} —— 先在 apps/desktop 下跑 node scripts/installer-art.mjs`,
    );
    process.exit(1);
  }
}
mkdirSync(outDir, { recursive: true });

/** 最小向导：页头页（目录页）+ 可选的欢迎页（侧边图）。
 *
 * 脚本里除标题外全 ASCII；标题用中文，所以落盘时要给 `.nsi` 写 **UTF-8 BOM**
 * （`Unicode true` 的 NSIS 没有 BOM 会把非 ASCII 读坏，实测直接编译失败）。
 * 标题写成「探针·自动关闭」，免得这个一闪而过的窗口被当成「应用名变了」。
 */
function probeScript({ outExe, withWelcome }) {
  return [
    "Unicode true",
    "ManifestDPIAware true",
    "ManifestDPIAwareness PerMonitorV2",
    'Name "KenFutWork 向导探针（自动关闭）"',
    `OutFile "${outExe}"`,
    'InstallDir "$TEMP\\kfwprobe"',
    "RequestExecutionLevel user",
    "",
    '!include "MUI2.nsh"',
    "!define MUI_ABORTWARNING",
    "!define MUI_HEADERIMAGE",
    `!define MUI_HEADERIMAGE_BITMAP "${headerBmp}"`,
    ...(withWelcome
      ? [
          `!define MUI_WELCOMEFINISHPAGE_BITMAP "${sidebarBmp}"`,
          "!insertmacro MUI_PAGE_WELCOME",
        ]
      : []),
    "!insertmacro MUI_PAGE_DIRECTORY",
    "!insertmacro MUI_PAGE_INSTFILES",
    '!insertmacro MUI_LANGUAGE "SimpChinese"',
    "",
    'Section "probe"',
    "SectionEnd",
    "",
  ].join("\n");
}

// 文件名一律 ASCII（`Unicode true` 的 NSIS 要求脚本带 BOM 才能读非 ASCII，中文名会编译失败）；
// 中文只用于控制台输出。
for (const [label, slug, withWelcome] of [
  ["页头", "header", false],
  ["侧边", "sidebar", true],
]) {
  const nsi = join(outDir, `probe-${slug}.nsi`);
  const exe = join(outDir, `probe-${slug}.exe`);
  const png = join(outDir, `${slug}.png`);
  writeFileSync(nsi, `\uFEFF${probeScript({ outExe: exe, withWelcome })}`);
  try {
    execFileSync(makensis, ["/V2", nsi], { stdio: "pipe" });
  } catch (error) {
    const log = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    console.error(`makensis 失败（${label}）：\n${log || error.message}`);
    process.exit(1);
  }
  const captured = execFileSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(here, "capture-window.ps1"),
      "-Exe",
      exe,
      "-Out",
      png,
      "-WaitMs",
      "3000",
    ],
    { encoding: "utf8" },
  );
  console.log(`${label}：${captured.trim()}`);
}

console.log(`\n抓屏产物：${outDir}`);
