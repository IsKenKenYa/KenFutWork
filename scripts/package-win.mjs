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
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const RELEASE = join(ROOT, "release");
const BUILD = join(RELEASE, "build");
const EXE_NAME = "KenFutWork-server.exe";

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

function main() {
  if (process.platform !== "win32") {
    console.error("[package] 本脚本仅支持在 Windows 上打包 Windows exe。");
    process.exit(1);
  }

  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });

  // 1) 构建共享契约包与静态 UI
  run("构建 @loomic/shared", "pnpm", ["--filter", "@loomic/shared", "build"]);
  run("构建静态 UI", "pnpm", ["--filter", "@loomic/web", "build"]);
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

  // 4) 组装 release/：exe + 静态 UI + 启动脚本 + 说明
  const releaseWeb = join(RELEASE, "web");
  cpSync(webOut, releaseWeb, { recursive: true });

  writeFileSync(
    join(RELEASE, "启动.bat"),
    `@echo off
rem KenFutWork 本地服务启动器：双击后启动服务端并打开浏览器
rem 如需连接你自己的 Supabase / 自管 Postgres，在同目录创建 .env 文件（键=值 每行一条）覆盖默认值。
setlocal
set "LOOMIC_SERVER_PORT=3001"
set "LOOMIC_WEB_ORIGIN=http://localhost:3001"
set "LOOMIC_WEB_DIST=%~dp0web"
set "SUPABASE_URL=http://127.0.0.1:54321"
set "SUPABASE_ANON_KEY=local-test-anon-key"
set "SUPABASE_JWT_SECRET=local-click-test-hmac-secret"
set "SUPABASE_SERVICE_ROLE_KEY=local-test-service-role-key"
set "LOOMIC_AGENT_MODEL=google:gemini-2.5-flash"
if exist "%~dp0.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0.env") do set "%%a=%%b"
)
echo KenFutWork 服务启动中：http://localhost:%LOOMIC_SERVER_PORT%
start "" http://localhost:%LOOMIC_SERVER_PORT%
"%~dp0${EXE_NAME}"
pause
`,
  );

  writeFileSync(
    join(RELEASE, "说明.txt"),
    `KenFutWork Windows 本地包
========================

双击「启动.bat」即可：自动启动本地服务端并打开浏览器（http://localhost:3001）。
默认使用内置本地演示环境（数据不入库、不持久，任意邮箱密码可登录）。

连接真实后端（Supabase / 自管 Postgres 网关）：
  在本目录新建 .env 文件，每行一条「键=值」，可用键与 .env.example 一致，例如：
    SUPABASE_URL=https://your-project.supabase.co
    SUPABASE_ANON_KEY=your-anon-key
    SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
    SUPABASE_JWT_SECRET=your-jwt-secret
    LOOMIC_AGENT_MODEL=google:gemini-2.5-flash
    GOOGLE_API_KEY=your-key

端口：默认 3001，可在 .env 中用 LOOMIC_SERVER_PORT 修改。
`,
  );

  console.log("");
  console.log(`[package] 打包完成：${RELEASE}`);
  console.log(`[package]   ${EXE_NAME}  +  web/  +  启动.bat  +  说明.txt`);
}

main();
