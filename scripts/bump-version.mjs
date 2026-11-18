#!/usr/bin/env node
/**
 * 桌面版本号一处改齐四处（手工四改必然漂移）。
 *
 * 版本声明当前落在四个文件：`tauri.conf.json`（Tauri 产出门禁，视为权威）、
 * `src-tauri/Cargo.toml`（[package] 段）、`src-tauri/Cargo.lock`（kenfutwork-desktop 条目）、
 * `apps/desktop/package.json`。四处由 `tests/workspace.test.mjs` 的
 * 「桌面版本四处一致」门禁对账，本脚本是唯一写入入口。
 *
 * 用法：pnpm version:bump 0.1.4
 * 语义（0.y.z 阶段）：MINOR = 里程碑（DEC 批次落地 / 新 FORM 上线）；PATCH = 安装包轮次。
 * 只写文件，不建 git tag、不发 Release——那些属于 `pnpm verify:desktop` 之后的发版步骤。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const TARGETS = [
  "apps/desktop/src-tauri/tauri.conf.json",
  "apps/desktop/src-tauri/Cargo.toml",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/package.json",
];

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    "用法：pnpm version:bump <x.y.z>（例：pnpm version:bump 0.1.4）",
  );
  process.exit(1);
}

/** 只替换匹配到的第一处；找不到即 fail loud，绝不静默跳过（那会留下半改状态）。 */
function replaceOnce(rel, pattern, build, label) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) {
    console.error(`找不到文件：${rel}`);
    process.exit(1);
  }
  const before = readFileSync(file, "utf8");
  const match = before.match(pattern);
  if (!match) {
    console.error(
      `${rel} 里找不到${label}——文件形状变了，改脚本对齐真实结构，别手改。`,
    );
    process.exit(1);
  }
  const after = before.replace(pattern, build(match));
  if (after === before) {
    console.log(`· ${rel} 已是 ${version}`);
    return;
  }
  writeFileSync(file, after);
  console.log(`✓ ${rel} → ${version}`);
}

replaceOnce(
  TARGETS[0],
  /("version":\s*")[^"]+(")/,
  (m) => `${m[1]}${version}${m[2]}`,
  '"version" 字段',
);

// Cargo.toml 里依赖行也有 `version = `，故只动 [package] 段的那一处。
replaceOnce(
  TARGETS[1],
  /(\[package\][^[]*?version = ")[^"]+(")/,
  (m) => `${m[1]}${version}${m[2]}`,
  "[package] 段的 version",
);

// Cargo.lock 按包名定位，避免动到其它包的版本行。
replaceOnce(
  TARGETS[2],
  /(name = "kenfutwork-desktop"\nversion = ")[^"]+(")/,
  (m) => `${m[1]}${version}${m[2]}`,
  "kenfutwork-desktop 的 version",
);

replaceOnce(
  TARGETS[3],
  /("version":\s*")[^"]+(")/,
  (m) => `${m[1]}${version}${m[2]}`,
  '"version" 字段',
);

console.log(`\n版本已改齐四处：${version}`);
console.log("下一步：pnpm test 跑版本一致门禁，再按出包链执行。");
