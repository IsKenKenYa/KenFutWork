/**
 * Windows 生产包打包：产出 release/KenFutWork-server.exe（Node SEA 单文件服务端）
 * + 静态 UI（web/）+ 启动.bat。产出的目录可整体拷贝到任意 Windows 机器运行（无需 Node）。
 *
 * 前置：pnpm install 已执行（esbuild/postject 为根 devDependencies）。
 * 用法：pnpm package:win
 */

import { execSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const RELEASE = join(ROOT, "release");
const BUILD = join(RELEASE, "build");
const EXE_NAME = "KenFutWork-server.exe";
/** 内嵌 Postgres 二进制来源（按平台可选依赖分发的 PG 17 线）。 */
const PG_PACKAGE = "@embedded-postgres/windows-x64";
/** 同源迁移与供给前导（桌面首启动即建全 schema）。 */
const SUPABASE_DIR = join(ROOT, "supabase");
/** pgmq 兼容 shim（历史迁移 CREATE EXTENSION pgmq 需要，见 desktop/pgmq-shim.ts）。 */
const SHIM_DIR = join(ROOT, "docker", "pg-dev-shim");

function run(label, command, args, options = {}) {
  console.log(`[package] ${label}…`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    shell: process.platform === "win32",
    stdio: options.quiet ? "ignore" : "inherit",
    ...options,
  });
  if (result.status !== 0) {
    console.error(`[package] ${label} 失败（exit=${result.status}）`);
    process.exit(result.status ?? 1);
  }
}

/** 解析内嵌 Postgres 二进制所在包目录（<pkg>/native）。 */
function resolvePgNativeDir() {
  // 从 apps/server 解析（该包是其可选依赖），避免走 shell 传参被引号吃掉
  const serverRequire = createRequire(
    join(ROOT, "apps", "server", "package.json"),
  );
  let entry;
  try {
    entry = serverRequire.resolve(PG_PACKAGE);
  } catch {
    console.error(
      "[package] 未找到内嵌 Postgres 二进制包，请先 pnpm install（需要 " +
        PG_PACKAGE +
        "）。",
    );
    process.exit(1);
  }
  const nativeDir = join(entry, "..", "..", "native");
  if (!existsSync(join(nativeDir, "bin"))) {
    console.error("[package] 二进制包结构不符（缺 native/bin）：" + nativeDir);
    process.exit(1);
  }
  return nativeDir;
}

function main() {
  if (process.platform !== "win32") {
    console.error("[package] 本脚本仅支持在 Windows 上打包 Windows exe。");
    process.exit(1);
  }

  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });

  // 1) 构建共享契约包与静态 UI
  run("构建 @kenfutwork/shared", "pnpm", ["--filter", "@kenfutwork/shared", "build"]);
  run("构建静态 UI", "pnpm", ["--filter", "@kenfutwork/web", "build"]);
  const webOut = join(ROOT, "apps", "web", "out");
  if (!existsSync(join(webOut, "index.html"))) {
    console.error("[package] 静态导出缺失（apps/web/out）");
    process.exit(1);
  }

  // 2) esbuild 打包服务端为单文件 CJS（SEA 要求 CommonJS）
  run("打包服务端（esbuild）", "pnpm", [
    "exec",
    "esbuild",
    "apps/server/src/server.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    // ESM-only 依赖（sharp 等）在模块顶层用 createRequire(import.meta.url) 定位自身；
    // CJS/SEA 打包下 import.meta 是空对象 → createRequire(undefined) 直接抛，包根本起不来。
    // CJS 里 __filename/__dirname 恒可用，把 import.meta 的这两个字段指过去。
    "--define:import.meta.url=__filename",
    "--define:import.meta.dirname=__dirname",
    `--outfile=${join(BUILD, "server.cjs")}`,
    "--log-level=warning",
  ]);

  // 3) Node SEA：生成 blob → 注入 node.exe 副本
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

  // 4) 组装 release/：exe + 静态 UI + 内嵌 Postgres + 迁移 SQL + 启动脚本 + 说明
  const releaseWeb = join(RELEASE, "web");
  cpSync(webOut, releaseWeb, { recursive: true });

  // 4a) 内嵌 Postgres 二进制：<exe>/pg/bin 是运行时的第一解析目标（desktop/postgres.ts）。
  //     share/ 不能省——initdb 需要 postgres.bki / 时区 / 内置扩展。
  const pgNative = resolvePgNativeDir();
  for (const part of ["bin", "lib", "share"]) {
    cpSync(join(pgNative, part), join(RELEASE, "pg", part), {
      recursive: true,
    });
  }
  for (const file of ["pgmq.control", "pgmq--1.0.sql"]) {
    cpSync(join(SHIM_DIR, file), join(RELEASE, "pg", "shim", file));
  }

  // 4b) 同源迁移：桌面首启动按此建 schema（不依赖仓库目录）
  cpSync(
    join(SUPABASE_DIR, "migrations"),
    join(RELEASE, "supabase", "migrations"),
    {
      recursive: true,
    },
  );
  cpSync(
    join(SUPABASE_DIR, "bootstrap"),
    join(RELEASE, "supabase", "bootstrap"),
    {
      recursive: true,
    },
  );

  console.log(
    "[package] 捆绑内嵌 Postgres（pg/）+ 迁移 SQL（supabase/）+ pgmq shim",
  );

  // 4c) sharp 的原生扩展：sharp 的 JS 被打进 bundle，但它按 __filename 解析
  //     @img/sharp-<platform>/sharp.node；SEA 下 __filename 是 exe，故原生包必须
  //     落在 <exe>/node_modules/@img/ 才能被找到（否则启动即 'Could not load sharp'）。
  const serverRequire = createRequire(
    join(ROOT, "apps", "server", "package.json"),
  );
  const sharpNative = serverRequire.resolve("@img/sharp-win32-x64/sharp.node");
  cpSync(
    dirname(sharpNative),
    join(RELEASE, "node_modules", "@img", "sharp-win32-x64"),
    {
      recursive: true,
    },
  );
  console.log(
    "[package] 捆绑 sharp 原生扩展（node_modules/@img/sharp-win32-x64）",
  );

  // 4d) 随包语言运行时（Node / Python / JRE）：agent 的 execute 跑在**宿主机**上，
  //     用户机器没装 Node/Python/JDK 时「建 python 项目」「跑 Java」「npx 起 MCP server」
  //     都不可用。由 scripts/fetch-runtimes.mjs 预取，这里整目录拷进包（<exeDir>/runtime/，
  //     由 desktop/runtimes.ts 解析并注入 sandbox PATH）。
  const runtimeDir = join(ROOT, "runtime");
  const runtimeNames = existsSync(runtimeDir)
    ? readdirSync(runtimeDir).filter((name) =>
        statSync(join(runtimeDir, name)).isDirectory(),
      )
    : [];
  if (runtimeNames.length > 0) {
    cpSync(runtimeDir, join(RELEASE, "runtime"), { recursive: true });
    console.log(
      `[package] 捆绑随包运行时（runtime/）：${runtimeNames.join("、")}`,
    );
  } else {
    console.warn(
      "[package] 未发现 runtime/：agent 将依赖宿主机自带的 Node/Python/JDK。先跑 pnpm fetch:runtimes 再打包。",
    );
  }

  writeFileSync(
    join(RELEASE, "启动.bat"),
    `@echo off
rem KenFutWork 桌面启动器：内嵌 Postgres + 本机免登录，开箱即用（无需安装数据库）
rem 自定义：同目录建 .env（每行「键=值」）覆盖下列默认值。
setlocal
cd /d "%~dp0"
set "KENFUTWORK_EMBEDDED_PG=1"
set "KENFUTWORK_AUTH_DRIVER=local-trust"
set "KENFUTWORK_QUEUE_DRIVER=in-process"
set "KENFUTWORK_SERVER_PORT=3001"
set "KENFUTWORK_WEB_ORIGIN=http://127.0.0.1:3001"
set "KENFUTWORK_WEB_DIST=%~dp0web"
rem 数据目录默认 %LOCALAPPDATA%\\KenFutWork\\data；需要随身携带再设 KENFUTWORK_DATA_DIR
set "KENFUTWORK_AGENT_MODEL=google:gemini-2.5-flash"
if exist "%~dp0.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0.env") do set "%%a=%%b"
)
echo KenFutWork 启动中：http://localhost:%KENFUTWORK_SERVER_PORT%
start "" http://localhost:%KENFUTWORK_SERVER_PORT%
"%~dp0${EXE_NAME}"
pause
`,
  );

  writeFileSync(
    join(RELEASE, "说明.txt"),
    `KenFutWork Windows 桌面包
======================

双击「启动.bat」即可：自动在 %LOCALAPPDATA%\\KenFutWork\\data 初始化本机数据库并打开浏览器
（http://localhost:3001）。首次启动需十几秒建库，之后是秒级。

形态说明（无需任何外部服务，可离线使用）
  数据库：随包内嵌 Postgres（pg/），首启动 initdb + 执行随包迁移 SQL（supabase/）
  认证：本机免登录（只监听 127.0.0.1，仅本机可访问）
  队列：进程内（不依赖 Postgres 扩展）
  文件：本机磁盘（数据目录下的 blobs/）
  运行时：随包 Node / Python / JDK（runtime/）——agent 执行命令时自动注入其路径，
          无需在系统里预装；若打包时未取到 runtime/，则回退用系统自带的那些

模型与搜索
  在本目录新建 .env，每行一条「键=值」，例如：
    KENFUTWORK_AGENT_MODEL=google:gemini-2.5-flash
    GOOGLE_API_KEY=your-key
  供应商 Key 也可在界面里按 BYOK 添加（加密后只存本机数据目录）。

端口：默认 3001，可在 .env 中用 KENFUTWORK_SERVER_PORT 修改。
重置数据：删除 %LOCALAPPDATA%\\KenFutWork\\data 即回到全新状态。
`,
  );

  console.log("");
  console.log(`[package] 打包完成：${RELEASE}`);
  console.log(`[package]   ${EXE_NAME}  +  web/  +  启动.bat  +  说明.txt`);
}

main();
