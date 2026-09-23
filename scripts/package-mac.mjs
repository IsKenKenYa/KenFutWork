/**
 * macOS（Apple Silicon）生产包打包：产出 release/KenFutWork-server（Node SEA 单文件
 * 服务端，无后缀——Rust 壳 bundled_server_exe 的 cfg(not(windows)) 分支按这个名字找）
 * + 静态 UI（web/）+ 内嵌 Postgres + 随包运行时。产物经 tauri.macos.conf.json 的
 * resources 映射进 .app（Contents/Resources/app/…）。
 *
 * 与 scripts/package-win.mjs 是**镜像脚本**（SEA/postject/pg/sharp/node-pty 六步同构），
 * 有意不抽公共库：两条管线分属两台打包机、由不同人维护，耦合在一起会让每次合并都
 * 冲突。差异点（都标注在对应步骤）：
 *   - postject 注入会**破坏 arm64 强制签名**，注入后必须 `codesign -f -s -` 重签；
 *   - darwin 的 PG 包带 pg-symlinks.json（libicudata 等未带版本号的 dylib 软链），
 *     直接 cp 会丢链接 → initdb 报 image not found（docs/日志.md libicudata 前车之鉴）；
 *   - sharp 原生包是 @img/sharp-darwin-arm64；node-pty 用 prebuilds/darwin-arm64；
 *   - 随包运行时来自 fetch-runtimes.mjs 的 darwin-arm64 分支（node/python/uv/jdk）。
 *
 * 前置：pnpm install（esbuild/postject 为根 devDependencies）、
 *       `pnpm --filter @kenfutwork/server install` 已含 @img/sharp-darwin-arm64、
 *       fetch-runtimes 已跑（可选，缺了运行时如实降级宿主机）。
 * 用法：pnpm package:mac
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const RELEASE = join(ROOT, "release");
const BUILD = join(RELEASE, "build");
/** mac 产物无后缀：lib.rs bundled_server_exe 的 cfg(not(windows)) 分支按此名探测。 */
const EXE_NAME = "KenFutWork-server";
/** 内嵌 Postgres 二进制来源（按平台可选依赖分发的 PG 17 线）。 */
const PG_PACKAGE = "@embedded-postgres/darwin-arm64";
/** sharp 的 darwin 原生扩展（SEA 下按 <exeDir>/node_modules/@img/ 解析）。 */
const SHARP_PACKAGE = "@img/sharp-darwin-arm64";
/** 同源迁移与供给前导（桌面首启动即建全 schema）。 */
const SUPABASE_DIR = join(ROOT, "supabase");
/** pgmq 兼容 shim（历史迁移 CREATE EXTENSION pgmq 需要，见 desktop/pgmq-shim.ts）。 */
const SHIM_DIR = join(ROOT, "docker", "pg-dev-shim");

function run(label, command, args, options = {}) {
  console.log(`[package-mac] ${label}…`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.quiet ? "ignore" : "inherit",
    ...options,
  });
  if (result.status !== 0) {
    console.error(`[package-mac] ${label} 失败（exit=${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

/** 从解析出的入口文件向上找包根（node-pty 等包的 exports 不暴露 ./package.json）。 */
function packageDirOf(entryPath) {
  let dir = dirname(entryPath);
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) {
      throw new Error(`向上找不到 package.json：${entryPath}`);
    }
    dir = up;
  }
  return dir;
}

/** 解析内嵌 Postgres 二进制所在包目录（<pkg>/native）。 */
function resolvePgNativeDir() {
  const serverRequire = createRequire(
    join(ROOT, "apps", "server", "package.json"),
  );
  let entry;
  try {
    // 裸说明符（该包 exports 不暴露 ./package.json 子路径）
    entry = serverRequire.resolve(PG_PACKAGE);
  } catch {
    console.error(
      `[package-mac] 未找到内嵌 Postgres 二进制包，请先 pnpm install（需要 ${PG_PACKAGE}）。`,
    );
    process.exit(1);
  }
  const nativeDir = join(dirname(entry), "..", "native");
  if (!existsSync(join(nativeDir, "bin"))) {
    console.error(`[package-mac] 二进制包结构不符（缺 native/bin）：${nativeDir}`);
    process.exit(1);
  }
  return nativeDir;
}

/**
 * 复刻 PG 包的 pg-symlinks.json：清单形如
 * `[{ source: "native/lib/libicudata.68.2.dylib", target: "native/lib/libicudata.dylib" }]`
 * （source=真身，target=应存在的软链）。npm 装包时由上游 postinstall 建，直接 cp
 * 会丢——initdb/psql 运行时按无版本号名 dlopen，缺了就是 image not found。
 */
function replicatePgSymlinks(nativeDir, pgOutDir) {
  const manifestPath = join(nativeDir, "pg-symlinks.json");
  if (!existsSync(manifestPath)) {
    // 老版本包没有该清单：照旧裸拷（现状可用的包不受影响）
    console.log("[package-mac] PG 包无 pg-symlinks.json，跳过软链复刻");
    return;
  }
  for (const entry of JSON.parse(readFileSync(manifestPath, "utf8"))) {
    const source = entry.source.replace(/^native\//, "");
    const target = entry.target.replace(/^native\//, "");
    const targetPath = join(pgOutDir, target);
    mkdirSync(dirname(targetPath), { recursive: true });
    rmSync(targetPath, { force: true });
    symlinkSync(basename(source), targetPath);
  }
  const count = JSON.parse(readFileSync(manifestPath, "utf8")).length;
  console.log(`[package-mac] 已复刻 PG 软链 ${count} 条（pg-symlinks.json）`);
}

function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error(
      "[package-mac] 本脚本仅支持在 macOS Apple Silicon（darwin/arm64）上打包。",
    );
    process.exit(1);
  }

  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });

  // 1) 构建共享契约包与静态 UI（同源口径与 Windows 一致：API base 必须是相对路径）
  run("构建 @kenfutwork/shared", "pnpm", [
    "--filter",
    "@kenfutwork/shared",
    "build",
  ]);
  run("构建静态 UI（同源）", "pnpm", ["--filter", "@kenfutwork/web", "build"], {
    env: { ...process.env, NEXT_PUBLIC_SERVER_BASE_URL: "" },
  });
  const webOut = join(ROOT, "apps", "web", "out");
  if (!existsSync(join(webOut, "index.html"))) {
    console.error("[package-mac] 静态导出缺失（apps/web/out）");
    process.exit(1);
  }
  if (!existsSync(join(webOut, "canvas.html"))) {
    console.error(
      "[package-mac] 静态导出里没有 canvas.html：Design 模式的画布要它兜底",
    );
    process.exit(1);
  }
  // 启动中页面（与 Windows 相同的机制，见 package-win.mjs 的详细注释）
  const splashSource = join(ROOT, "apps", "desktop", "splash.html");
  if (!existsSync(splashSource)) {
    console.error("[package-mac] 缺少启动页 apps/desktop/splash.html");
    process.exit(1);
  }
  copyFileSync(splashSource, join(webOut, "_splash.html"));
  console.log("[package-mac] 启动页已写入静态导出：_splash.html");

  // 2) esbuild 打包服务端为单文件 CJS（SEA 要求 CommonJS；external 口径与 Windows 一致）
  run("打包服务端（esbuild）", "pnpm", [
    "exec",
    "esbuild",
    "apps/server/src/server.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--define:import.meta.url=__filename",
    "--define:import.meta.dirname=__dirname",
    "--external:node-pty",
    `--outfile=${join(BUILD, "server.cjs")}`,
    "--log-level=warning",
  ]);

  // 3) Node SEA：生成 blob → 注入 node 副本 → **重签**
  const nodeExe = process.execPath;
  const seaConfig = join(BUILD, "sea-config.json");
  writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: join(BUILD, "server.cjs"),
        output: join(BUILD, "sea-prep.blob"),
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );
  run("生成 SEA blob", nodeExe, ["--experimental-sea-config", seaConfig]);

  const exePath = join(RELEASE, EXE_NAME);
  copyFileSync(nodeExe, exePath);
  run(
    "注入 SEA blob（postject）",
    "pnpm",
    [
      "exec",
      "postject",
      exePath,
      "NODE_SEA_BLOB",
      join(BUILD, "sea-prep.blob"),
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    { quiet: true },
  );
  // arm64 上 macOS 强制所有可执行体带签名：postject 注入后原签名作废，二进制直接
  // 被 kill（Killed: 9）。ad-hoc 重签（“-”身份）即可本机运行；对外分发需 Developer ID。
  run("ad-hoc 重签服务端二进制", "codesign", ["--force", "--sign", "-", exePath]);

  // 4) 组装 release/：二进制 + 静态 UI + 内嵌 Postgres + 迁移 SQL
  const releaseWeb = join(RELEASE, "web");
  cpSync(webOut, releaseWeb, { recursive: true });

  // 4a) 内嵌 Postgres：<exe>/pg/bin 是运行时第一解析目标（desktop/postgres.ts）。
  const pgNative = resolvePgNativeDir();
  for (const part of ["bin", "lib", "share"]) {
    cpSync(join(pgNative, part), join(RELEASE, "pg", part), {
      recursive: true,
    });
  }
  replicatePgSymlinks(pgNative, join(RELEASE, "pg"));
  for (const file of ["pgmq.control", "pgmq--1.0.sql"]) {
    cpSync(join(SHIM_DIR, file), join(RELEASE, "pg", "shim", file));
  }

  // 4b) 同源迁移
  cpSync(
    join(SUPABASE_DIR, "migrations"),
    join(RELEASE, "supabase", "migrations"),
    { recursive: true },
  );
  cpSync(
    join(SUPABASE_DIR, "bootstrap"),
    join(RELEASE, "supabase", "bootstrap"),
    { recursive: true },
  );
  console.log(
    "[package-mac] 捆绑内嵌 Postgres（pg/）+ 迁移 SQL（supabase/）+ pgmq shim",
  );

  // 4c) sharp 的 darwin 原生扩展（SEA 下按 <exe>/node_modules/@img/ 解析，同 Windows 口径）
  const serverRequire = createRequire(
    join(ROOT, "apps", "server", "package.json"),
  );
  // @img/sharp-* 的 exports 连 "." 都没暴露，require.resolve 走不通；pnpm 布局下
  // 可选依赖必然落在 apps/server/node_modules/@img/（缺了 = 没 install，fail loud）。
  // 注意 SHARP_PACKAGE 自带 @img/ 作用域前缀，路径里不要再拼一层。
  const sharpDir = join(ROOT, "apps", "server", "node_modules", SHARP_PACKAGE);
  if (!existsSync(join(sharpDir, "package.json"))) {
    console.error(
      `[package-mac] 缺 ${SHARP_PACKAGE}（apps/server optionalDependencies），先 pnpm install。`,
    );
    process.exit(1);
  }
  cpSync(sharpDir, join(RELEASE, "node_modules", SHARP_PACKAGE), {
    recursive: true,
  });
  console.log(`[package-mac] 捆绑 sharp 原生扩展（node_modules/${SHARP_PACKAGE}）`);

  // 4c-2) node-pty（终端的真 PTY）：lib/ + prebuilds/darwin-arm64（pty.node + spawn-helper）
  //   + package.json。mac 无 conpty（那是 Windows 的伪终端方案）。
  const nodePtyDir = packageDirOf(serverRequire.resolve("node-pty"));
  const nodePtyOut = join(RELEASE, "node_modules", "node-pty");
  for (const rel of ["lib", "typings"]) {
    const from = join(nodePtyDir, rel);
    if (existsSync(from)) {
      cpSync(from, join(nodePtyOut, rel), { recursive: true });
    }
  }
  const prebuilds = join(nodePtyDir, "prebuilds", "darwin-arm64");
  if (existsSync(prebuilds)) {
    cpSync(prebuilds, join(nodePtyOut, "prebuilds", "darwin-arm64"), {
      recursive: true,
    });
  } else {
    console.error(
      "[package-mac] node-pty 缺 prebuilds/darwin-arm64（终端会不可用）；先在本机 pnpm install 让它构建/下载。",
    );
    process.exit(1);
  }
  cpSync(join(nodePtyDir, "package.json"), join(nodePtyOut, "package.json"));
  console.log("[package-mac] 捆绑 node-pty（lib/ + prebuilds/darwin-arm64）");

  // 4d) 随包语言运行时（darwin-arm64 资产，见 fetch-runtimes.mjs 的 darwin 分支）
  const runtimeDir = join(ROOT, "runtime");
  const runtimeNames = existsSync(runtimeDir)
    ? readdirSync(runtimeDir).filter((name) =>
        statSync(join(runtimeDir, name)).isDirectory(),
      )
    : [];
  if (runtimeNames.length > 0) {
    cpSync(runtimeDir, join(RELEASE, "runtime"), { recursive: true });
    console.log(
      `[package-mac] 捆绑随包运行时（runtime/）：${runtimeNames.join("、")}`,
    );
  } else {
    console.warn(
      "[package-mac] 未发现 runtime/：agent 将依赖宿主机自带的 Node/Python/JDK。先跑 pnpm fetch:runtimes 再打包。",
    );
  }

  console.log("");
  console.log(`[package-mac] 打包完成：${RELEASE}`);
  console.log(`[package-mac]   ${EXE_NAME}  +  web/  +  pg/  +  runtime/`);
  console.log(
    "[package-mac] 下一步：pnpm --filter @kenfutwork/desktop build（tauri 出 .app 与 DMG）",
  );
}

main();
