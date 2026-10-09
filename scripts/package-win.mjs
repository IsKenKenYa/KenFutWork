/**
 * Windows 生产包打包：产出 release/KenFutWork-server.exe（Node SEA 单文件服务端）
 * + 静态 UI（web/）+ 启动.bat。产出的目录可整体拷贝到任意 Windows 机器运行（无需 Node）。
 *
 * 前置：pnpm install 已执行（esbuild/postject 为根 devDependencies）。
 * 用法：pnpm package:win
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
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  packageCodeNativeRuntime,
  packageRipgrepRuntime,
} from "./package-code-native.mjs";

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
  const { trimLongLines = false, ...spawn } = options;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    shell: process.platform === "win32",
    // 打包含单行 18MB 的产物：报错时 Node 会把整行源码打出来，Actions 按行长截断后
    // **真正的错误信息被吃掉**（实测只剩一段 wasmBase64）。需要看报错的步骤一律
    // 捕获后按行截断输出，保留错误行本身。
    stdio: trimLongLines ? "pipe" : spawn.quiet ? "ignore" : "inherit",
    ...(trimLongLines ? { encoding: "utf8" } : {}),
    ...spawn,
  });
  if (trimLongLines) {
    const shorten = (text) =>
      String(text ?? "")
        .split("\n")
        .map((line) =>
          line.length > 300
            ? `${line.slice(0, 160)} …<单行 ${line.length} 字符，已截断>… ${line.slice(-60)}`
            : line,
        )
        .join("\n");
    if (result.stdout) process.stdout.write(shorten(result.stdout));
    if (result.stderr) process.stderr.write(shorten(result.stderr));
  }
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
    console.error(`[package] 二进制包结构不符（缺 native/bin）：${nativeDir}`);
    process.exit(1);
  }
  return nativeDir;
}

/**
 * SEA 宿主取 `process.execPath`——构建机上跑的那个 node，就是随包服务端将来运行的 node。
 * 不锁版本就会「同一 commit 两台机器出两个不同 node 的 exe 且无人记账」，故与根 `.nvmrc`
 * 精确对账，不一致即拒绝出包。
 *
 * 注：`--sentinel-fuse` 的 `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` 是 Node 源码里的
 * 固定常量（本机实测 node 22.20.0 与 24.11.1 同值），**与版本无关**，别把它当版本指纹改。
 */
function assertNodeMatchesPin() {
  const pinPath = join(ROOT, ".nvmrc");
  if (!existsSync(pinPath)) {
    console.error(
      "[package] 缺根 `.nvmrc`：SEA 宿主版本无从对账，先补该文件。",
    );
    process.exit(1);
  }
  const pin = readFileSync(pinPath, "utf8").trim();
  if (process.version !== `v${pin}`) {
    console.error(
      `[package] SEA 宿主版本与 .nvmrc 不符：当前 ${process.version}，钉的是 v${pin}。\n` +
        "  本机：nvm use " +
        pin +
        "（或装对应版本）后重跑 pnpm package:win。\n" +
        "  CI：actions/setup-node 用 node-version-file: .nvmrc。",
    );
    process.exit(1);
  }
  console.log(`[package] SEA 宿主与 .nvmrc 一致：v${pin}`);
}

function main() {
  if (process.platform !== "win32") {
    console.error("[package] 本脚本仅支持在 Windows 上打包 Windows exe。");
    process.exit(1);
  }

  assertNodeMatchesPin();

  rmSync(RELEASE, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });

  // 1) 构建共享契约包与静态 UI
  run("构建 @kenfutwork/shared", "pnpm", [
    "--filter",
    "@kenfutwork/shared",
    "build",
  ]);
  // 静态 UI 必须按**同源**构建（`NEXT_PUBLIC_SERVER_BASE_URL` 置空 → API base 用相对路径）：
  // 随包 UI 永远由随包服务端自己托管，而仓库根 `.env.local` 里通常写着开发值
  // （`http://localhost:3001`）——那会被 Next 的 DefinePlugin **烘进产物**，装到别人机器上
  // 就成了「界面从自己的服务端加载、API 却打 3001」的半死状态（2026-09-19 真机实测：
  // 侧栏「未登录」、项目列表空、Design 模式的画布永远起不来）。
  run("构建静态 UI（同源）", "pnpm", ["--filter", "@kenfutwork/web", "build"], {
    env: { ...process.env, NEXT_PUBLIC_SERVER_BASE_URL: "" },
  });
  const webOut = join(ROOT, "apps", "web", "out");
  if (!existsSync(join(webOut, "index.html"))) {
    console.error("[package] 静态导出缺失（apps/web/out）");
    process.exit(1);
  }
  if (!existsSync(join(webOut, "canvas.html"))) {
    console.error(
      "[package] 静态导出里没有 canvas.html：Design 模式的画布要它兜底",
    );
    process.exit(1);
  }
  /**
   * 启动中页面：写成 `_splash.html` 放进静态导出目录，作为**窗口的初始 URL**
   * （`tauri.conf.json` 的 `windows[].url`）。
   *
   * 为什么要落到这里而不是让壳自己画：壳起来时要先拉起随包服务端（内嵌 Postgres 首启动
   * 要 initdb，可能几十秒），这段时间窗口需要一个**没有脚本依赖**的页面顶着——否则就是
   * 白屏（2026-09-19 用户反馈）。放静态导出目录是因为 Tauri 的 `frontendDist` 就是它，
   * 壳自带的资源协议只认这里；同时 `release/web` 也放一份，方便自托管形态照抄。
   */
  const splashSource = join(ROOT, "apps", "desktop", "splash.html");
  if (!existsSync(splashSource)) {
    console.error("[package] 缺少启动页 apps/desktop/splash.html");
    process.exit(1);
  }
  copyFileSync(splashSource, join(webOut, "_splash.html"));
  console.log("[package] 启动页已写入静态导出：_splash.html");

  packageCodeNativeRuntime(ROOT, RELEASE);
  packageRipgrepRuntime(ROOT, RELEASE);
  const brokerManifest =
    "apps/server/src/features/process-sandbox/native/Cargo.toml";
  run("构建Windows Task工作域代理", "cargo", [
    "build",
    "--release",
    "--manifest-path",
    brokerManifest,
  ]);
  run("构建独立进程执行helper", process.execPath, [
    "apps/server/src/features/process-sandbox/build-helper.mjs",
    join(RELEASE, "process-helper"),
    join(
      ROOT,
      "apps/server/src/features/process-sandbox/native/target/release/kenfutwork-process-broker.exe",
    ),
  ]);

  // 2) esbuild 打包服务端为单文件 CJS（SEA 要求 CommonJS）
  //
  // SEA 的 require 只认内置模块：`--external` 留在外面的原生包（@napi-rs/canvas、node-pty、
  // @vscode/ripgrep、sherpa-onnx-node）一旦被 `require("pkg")` 命中就是
  // ERR_UNKNOWN_BUILTIN_MODULE（实测 Windows exe 启动 1 秒即退，栈里是 embedderRequire）。
  // 且 SEA 里 `__filename` 是**生成 blob 时的构建机路径**，发布机上不存在，
  // 所以 import.meta.url 也不能直接映射到 __filename。
  // 统一在产物最前面建立「以发布 exe 位置为基准」的文件型 require：
  //   - require 重绑定为 createRequire(<exe>/server.cjs)，外部包从 <exe>/node_modules 解析；
  //   - import.meta.url 换成同一基准的 file URL，源码里的 createRequire(import.meta.url) 同锚点。
  // 非 SEA（`node server.cjs`）走原语义，两处基准都退回 __filename。
  const seaBanner = `
(() => {
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  let isSea = false;
  try {
    isSea = require("node:sea").isSea();
  } catch {}
  const base = isSea
    ? path.join(path.dirname(process.execPath), "server.cjs")
    : __filename;
  globalThis.__kfwModuleUrl = pathToFileURL(base).href;
  if (isSea) require = require("node:module").createRequire(base);
})();
`;
  run(
    "打包服务端（esbuild）",
    "pnpm",
    [
      "exec",
      "esbuild",
      "apps/server/src/server.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      // ESM-only 依赖（sharp 等）在模块顶层用 createRequire(import.meta.url) 定位自身；
      // CJS/SEA 打包下 import.meta 是空对象 → createRequire(undefined) 直接抛，包根本起不来。
      // 基准由上面的 banner 给出：SEA 里 __filename 是构建机路径，不能直接用。
      "--define:import.meta.url=globalThis.__kfwModuleUrl",
      "--define:import.meta.dirname=__dirname",
      `--banner:js=${seaBanner}`,
      // node-pty 是原生模块（conpty.node + conpty.dll/OpenConsole.exe）：**不能打进单文件**，
      // 运行时从 <exe>/node_modules/node-pty 解析（同 sharp 的办法）。
      "--external:node-pty",
      "--external:@napi-rs/canvas",
      "--external:@vscode/ripgrep",
      // sherpa-onnx-node 同理（语音助手的内置「听」）：它 require 平台包（sherpa-onnx-win-x64）
      // 里的 .node，打进单文件后既丢了 .node 也丢了平台包解析路径。
      "--external:sherpa-onnx-node",
      `--outfile=${join(BUILD, "server.cjs")}`,
      "--log-level=warning",
    ],
    { trimLongLines: true },
  );

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
  run("生成 SEA blob", nodeExe, ["--experimental-sea-config", seaConfig], {
    trimLongLines: true,
  });

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

  // 4c-2) node-pty（终端的真 PTY）：只拷运行时用得上的子集——
  //   lib/（JS）+ prebuilds/win32-x64/*.node + build/Release/conpty/{conpty.dll,OpenConsole.exe}
  //   + package.json；third_party / src / deps / 其它平台的 prebuilds 都不进包。
  const nodePtyDir = dirname(serverRequire.resolve("node-pty/package.json"));
  const nodePtyOut = join(RELEASE, "node_modules", "node-pty");
  for (const rel of ["lib", "build", "typings"]) {
    const from = join(nodePtyDir, rel);
    if (existsSync(from)) {
      cpSync(from, join(nodePtyOut, rel), { recursive: true });
    }
  }
  const prebuilds = join(nodePtyDir, "prebuilds", "win32-x64");
  if (existsSync(prebuilds)) {
    cpSync(prebuilds, join(nodePtyOut, "prebuilds", "win32-x64"), {
      recursive: true,
      // 调试符号（*.pdb）占了这份 prebuild 的一多半，运行时用不到
      filter: (source) => !source.endsWith(".pdb"),
    });
  }
  cpSync(join(nodePtyDir, "package.json"), join(nodePtyOut, "package.json"));
  console.log(
    "[package] 捆绑 node-pty（lib/ + prebuilds/win32-x64 + conpty.dll/OpenConsole.exe）",
  );

  // 4c-3) sherpa-onnx-node（语音助手内置「听」的原生运行时）：**整包拷**。
  //   JS 壳（sherpa-onnx.js 等）+ 平台包 sherpa-onnx-win-x64（onnxruntime.dll + .node）。
  //   它内部按 require('sherpa-onnx-' + platform) 解析，故平台包必须与它同级落在
  //   <exe>/node_modules/ 下；模型文件不在包里（按需下载到用户数据目录，规划 §5/§8）。
  try {
    const sherpaPkgPath = serverRequire.resolve(
      "sherpa-onnx-node/package.json",
    );
    const sherpaDir = dirname(sherpaPkgPath);
    const sherpaOut = join(RELEASE, "node_modules", "sherpa-onnx-node");
    cpSync(sherpaDir, sherpaOut, { recursive: true });
    // 平台包（含 23MB 原生库 + onnxruntime.dll）单独放同级 node_modules。
    // 解析顺序：先从 server 的依赖树找（平台包已在 optionalDependencies 里，pnpm 会链到
    // apps/server/node_modules）；找不到就退回从 sherpa-onnx-node 自身解析——pnpm 严格布局下
    // 它也可能只挂在 .pnpm 目录里。两条都试，别因为一处解析不到就静默不拷。
    let platformDir;
    try {
      platformDir = dirname(
        serverRequire.resolve("sherpa-onnx-win-x64/package.json"),
      );
    } catch {
      const sherpaRequire = createRequire(sherpaPkgPath);
      platformDir = dirname(
        sherpaRequire.resolve("sherpa-onnx-win-x64/package.json"),
      );
    }
    cpSync(platformDir, join(RELEASE, "node_modules", "sherpa-onnx-win-x64"), {
      recursive: true,
    });
    console.log(
      "[package] 捆绑语音运行时（sherpa-onnx-node + sherpa-onnx-win-x64）",
    );
  } catch (error) {
    // 不是硬失败：缺了它只是「语音不可用」（catalog 会在设置页如实说明模型未下载/运行时不可用）
    console.warn(
      `[package] 未捆绑语音运行时（内置「听」将不可用）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

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
    cpSync(runtimeDir, join(RELEASE, "runtime"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    console.log(
      `[package] 捆绑随包运行时（runtime/）：${runtimeNames.join("、")}`,
    );
  } else {
    console.warn(
      "[package] 未发现 runtime/：agent 将依赖宿主机自带的 Node/Python/JDK。先跑 pnpm fetch:runtimes 再打包。",
    );
  }

  writeFileSync(
    join(RELEASE, "打开浏览器.ps1"),
    `\uFEFF$ErrorActionPreference = 'Stop'
try {
  $output = & (Join-Path $PSScriptRoot '${EXE_NAME}') '--local-connection-url'
  if ($LASTEXITCODE -ne 0) { throw '本机服务未能签发连接票据，请检查启动日志。' }
  $url = ($output | Select-Object -Last 1).Trim()
  if ($url -notmatch '^http://127\\.0\\.0\\.1:[0-9]+/#connect=[A-Za-z0-9_-]{43}$') {
    throw '本机连接入口格式无效。'
  }
  Start-Process -FilePath $url
} catch {
  Write-Host ('打开浏览器失败：' + $_.Exception.Message)
  exit 1
}
`,
  );

  writeFileSync(
    join(RELEASE, "启动.bat"),
    `@echo off
rem KenFutWork 桌面启动器：内嵌 Postgres + 本机免登录，开箱即用（无需安装数据库）
rem 自定义：同目录建 .env（每行「键=值」）覆盖下列默认值。
setlocal
cd /d "%~dp0"
set "KENFUTWORK_EMBEDDED_PG=1"
set "KENFUTWORK_QUEUE_DRIVER=in-process"
set "KENFUTWORK_SERVER_PORT=3001"
set "KENFUTWORK_WEB_ORIGIN=http://127.0.0.1:3001"
set "KENFUTWORK_WEB_DIST=%~dp0web"
rem 默认数据目录与迁移指针由同源服务端解析；显式 KENFUTWORK_DATA_DIR 优先
set "KENFUTWORK_AGENT_MODEL=google:gemini-2.5-flash"
if exist "%~dp0.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0.env") do set "%%a=%%b"
)
echo KenFutWork 启动中：http://localhost:%KENFUTWORK_SERVER_PORT%
start "" /b powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0打开浏览器.ps1"
"%~dp0${EXE_NAME}"
pause
`,
  );

  writeFileSync(
    join(RELEASE, "说明.txt"),
    `KenFutWork Windows 桌面包
======================

双击「启动.bat」即可：初始化本机数据库，服务就绪后通过一次性连接入口打开浏览器。
默认数据目录是 %APPDATA%\\com.kenfutwork.desktop\\data；迁移后的目录由配置指针决定。
显式 KENFUTWORK_DATA_DIR 优先。首次启动需十几秒建库，之后是秒级。

形态说明（无需任何外部服务，可离线使用）
  数据库：随包内嵌 Postgres（pg/），首启动 initdb + 执行随包迁移 SQL（supabase/）
  接入：免账户，只监听回环；桌面凭据在宿主读取，浏览器兑换 HttpOnly 会话 cookie
  队列：进程内（不依赖 Postgres 扩展）
  文件：本机磁盘（数据目录下的 blobs/）
  运行时：随包 Node / Python / JDK（runtime/）——agent 执行命令时自动注入其路径，
          无需在系统里预装；若打包时未取到 runtime/，则回退用系统自带的那些

模型与搜索
  在本目录新建 .env，每行一条「键=值」，例如：
    KENFUTWORK_AGENT_MODEL=google:gemini-2.5-flash
    GOOGLE_API_KEY=your-key
  供应商 Key 也可在界面里按 BYOK 添加（明文文件只存本机数据目录，可查看和复制）。

端口：默认 3001，可在 .env 中用 KENFUTWORK_SERVER_PORT 修改。
备份恢复：完全退出应用和数据库后备份整个数据目录；恢复后启动，不自动重放任务。
重置数据：确认无需保留会话和配置后，删除当前数据目录即回到全新状态。
`,
  );

  console.log("");
  console.log(`[package] 打包完成：${RELEASE}`);
  console.log(`[package]   ${EXE_NAME}  +  web/  +  启动.bat  +  说明.txt`);
}

main();
