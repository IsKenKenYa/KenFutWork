#!/usr/bin/env node
/**
 * 桌面壳的 Cargo 门禁入口（`pnpm --filter @kenfutwork/desktop typecheck|test`）。
 *
 * 为什么要有这一层：**cargo 常常不在 PATH 里**（rustup 默认装到 `%USERPROFILE%\.cargo\bin`，
 * 新开的 shell / 编辑器里经常看不见），直接写 `cargo check` 只会得到一个 ENOENT，
 * 看起来像「仓库坏了」。这里先探 PATH、再探 rustup 的默认位置，都找不到才如实报错并指路。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const task = process.argv[2] === "test" ? "test" : "check";
const manifest = join(import.meta.dirname, "..", "src-tauri", "Cargo.toml");

/** PATH 里的 cargo 能不能跑通（跑不通返回 null）。 */
function cargoOnPath() {
  const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  return probe.error ? null : "cargo";
}

/** rustup 的默认安装位置（各平台）。 */
function cargoInRustupHome() {
  const home = join(homedir(), ".cargo", "bin");
  const candidate = join(
    home,
    process.platform === "win32" ? "cargo.exe" : "cargo",
  );
  return existsSync(candidate) ? candidate : null;
}

const cargo = cargoOnPath() ?? cargoInRustupHome();
if (!cargo) {
  console.error(
    "找不到 cargo：桌面壳（Tauri）需要 Rust 工具链。\n" +
      "装 rustup（https://rustup.rs）后重开终端；若已经装过，把 `%USERPROFILE%\\.cargo\\bin` 加进 PATH。",
  );
  process.exit(1);
}

const result = spawnSync(cargo, [task, "--manifest-path", manifest], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
