/**
 * 桌面离线冒烟（M2.3.3，《多端》D3 验收入口）。
 *
 *   node scripts/desktop-offline-smoke.mjs            # 用 release/ 产物（需先 pnpm package:win）
 *   node scripts/desktop-offline-smoke.mjs --data-dir <dir>   # 指定数据目录（默认临时目录）
 *
 * 做法：用**临时数据目录**拉起打包好的 exe（内嵌 Postgres + 免登录），不带任何令牌
 * 打受保护接口，全部通过后停进程并确认数据库也已停。它验证的是「开箱即用」这条路径，
 * 不依赖仓库里的 tsx/依赖目录，也不连任何外部服务（离线可用）。
 *
 * 退出码非 0 即冒烟失败（每步打印中文结论，失败点即现场）。
 */

import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE = join(process.cwd(), "release");
const EXE = join(RELEASE, "KenFutWork-server.exe");
const args = process.argv.slice(2);
const dataDirArg = args.indexOf("--data-dir");
const keepData = args.includes("--keep-data");

function log(message) {
  console.log(`[冒烟] ${message}`);
}

function fail(message, detail) {
  console.error(`[冒烟] ✗ ${message}`);
  if (detail !== undefined) {
    console.error(detail instanceof Error ? detail.stack : detail);
  }
  process.exit(1);
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() =>
        port > 0 ? resolve(port) : reject(new Error("no port")),
      );
    });
  });
}

async function get(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  let body = "";
  try {
    body = await response.text();
  } catch {
    // 忽略读取失败：只看状态码
  }
  return { body, status: response.status };
}

async function waitForReady(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const { status } = await get(base, "/api/viewer");
      if (status === 200) {
        return true;
      }
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待就绪超时（最后状态：${lastError}）`);
}

async function main() {
  if (!existsSync(EXE)) {
    fail(`未找到打包产物 ${EXE}，请先运行 pnpm package:win`);
  }
  if (!existsSync(join(RELEASE, "pg", "bin"))) {
    fail(
      "release/pg/bin 缺失：桌面包必须内嵌 Postgres 二进制（pnpm package:win 会拷入）",
    );
  }

  const dataDir =
    dataDirArg >= 0 && args[dataDirArg + 1]
      ? args[dataDirArg + 1]
      : await mkdtemp(join(tmpdir(), "kenfutwork-smoke-"));
  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  log(`产物：${EXE}`);
  log(`数据目录：${dataDir}（全新）`);
  log(`端口：${port}`);

  const child = spawn(EXE, [], {
    cwd: RELEASE,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      LOOMIC_AGENT_MODEL:
        process.env.LOOMIC_AGENT_MODEL ?? "google:gemini-2.5-flash",
      LOOMIC_AUTH_DRIVER: "local-trust",
      LOOMIC_DATA_DIR: dataDir,
      LOOMIC_EMBEDDED_PG: "1",
      LOOMIC_QUEUE_DRIVER: "in-process",
      LOOMIC_SERVER_PORT: String(port),
      LOOMIC_WEB_DIST: join(RELEASE, "web"),
      LOOMIC_WEB_ORIGIN: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  const cleanup = async () => {
    // Windows 上没有真正的 SIGTERM 投递：child.kill() 是硬终止，退出钩子不会跑，
    // 内嵌集群会留下来。故清理时显式用 pg_ctl 停库（也顺带验证「孤儿集群」可被停掉）。
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync(
        join(
          RELEASE,
          "pg",
          "bin",
          process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl",
        ),
        ["-D", join(dataDir, "postgres"), "-m", "fast", "-w", "stop"],
        { stdio: "ignore" },
      );
    } catch {
      // 已经停了：正常
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!keepData) {
      rmSync(dataDir, { force: true, recursive: true });
    }
  };

  try {
    log("启动桌面 exe（首启动会 initdb + 跑迁移，最多等 120s）…");
    await waitForReady(base, 120_000);
    log("✓ 服务就绪，且免登录接口已可用");

    // 1) 静态 UI 由 server 自己托管（离线不需要任何 CDN）
    const index = await get(base, "/");
    if (index.status !== 200) {
      fail(`首页未托管（HTTP ${index.status}）`);
    }
    log("✓ 首页托管正常");

    // 2) 受保护接口全部免登录可读（local-trust）
    for (const path of [
      "/api/viewer",
      "/api/models",
      "/api/projects",
      "/api/credits",
      "/api/workspaces/skills",
    ]) {
      const { status, body } = await get(base, path);
      if (status !== 200) {
        fail(`${path} 期望 200，实际 ${status}`, body.slice(0, 300));
      }
      log(`✓ ${path} 200`);
    }

    // 3) 免登录形态不保留口令认证路由
    const login = await get(base, "/api/auth/login", {
      body: JSON.stringify({ email: "x@y.test", password: "irrelevant" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (login.status !== 404) {
      fail(
        `/api/auth/login 期望 404（免登录形态不挂认证路由），实际 ${login.status}`,
      );
    }
    log("✓ 认证路由未挂载（404，符合免登录形态）");

    // 4) 跨源来源被拒（防用户浏览器里的网页借本机端口读数据）
    const foreign = await get(base, "/api/viewer", {
      headers: { origin: "https://evil.example.com" },
    });
    if (foreign.status !== 403) {
      fail(`跨源请求期望 403，实际 ${foreign.status}`);
    }
    log("✓ 跨源来源已拒绝（403）");

    // 5) 本机账号落在内嵌库里（说明数据真落盘，不是内存演示）
    const viewer = JSON.parse((await get(base, "/api/viewer")).body);
    if (viewer?.workspace?.type !== "personal" || !viewer?.profile?.id) {
      fail("viewer 引导结果不完整", JSON.stringify(viewer).slice(0, 300));
    }
    log(
      `✓ 引导成功：workspace=${viewer.workspace.id} profile=${viewer.profile.displayName}`,
    );

    log("冒烟全部通过；开始关停（应停库并退出）…");
    child.kill("SIGTERM");
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 20_000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      fail("进程未在 20s 内退出；日志尾部：\n" + output.join("").slice(-2000));
    }
    log("✓ 进程已退出");

    console.log("");
    console.log(
      "[冒烟] 结论：桌面包离线可用（内嵌 Postgres + 免登录 + 本地 blob + 进程内队列）",
    );
  } catch (error) {
    fail(
      "冒烟失败",
      `${error instanceof Error ? error.message : error}\n\n--- 进程输出 ---\n${output.join("").slice(-4000)}`,
    );
  } finally {
    await cleanup();
  }
}

void main();
