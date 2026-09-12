/**
 * 零配置本地启动：mock Supabase(54321) + API Server(3001) + Web(3000) 一键拉起。
 * - 首次运行自动生成占位 .env.local（不覆盖已存在的文件），无需任何真实 Supabase key
 * - 端口已被占用视为服务已在运行，直接复用
 * 用法：pnpm dev:local
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const IS_WIN = process.platform === "win32";
const MOCK_URL = "http://127.0.0.1:54321";
const SERVER_HEALTH = "http://127.0.0.1:3001/api/health";
const WEB_URL = "http://localhost:3000";

const children = [];

function log(message) {
  console.log(`[dev:local] ${message}`);
}

function ensureEnvFile(path, content) {
  if (existsSync(path)) {
    log(`已存在，跳过生成：${path}`);
    return;
  }
  writeFileSync(path, content, "utf8");
  log(`已生成占位环境文件：${path}`);
}

function prepareEnvFiles() {
  const credentialSecret = randomBytes(24).toString("hex");
  // JWT 密钥值与 scripts/本地mock-supabase.mjs 的 LOCAL_JWT_SECRET 保持一致（本地验签链路）
  const rootEnv = `# —— dev:local 自动生成：占位值，指向本地 mock（127.0.0.1:54321）——
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=local-test-anon-key
SUPABASE_SERVICE_ROLE_KEY=local-test-service-role-key
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
SUPABASE_PROJECT_ID=testproject
# 本地 HMAC 密钥：服务端走本地 JWT 校验（与 mock 签发密钥一致）
SUPABASE_JWT_SECRET=local-click-test-hmac-secret
LOOMIC_AGENT_MODEL=google:gemini-2.5-flash
LOOMIC_WEB_ORIGIN=http://localhost:3000
LOOMIC_CREDENTIAL_SECRET=${credentialSecret}
`;
  const webEnv = `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=local-test-anon-key
NEXT_PUBLIC_SERVER_BASE_URL=
`;
  ensureEnvFile(join(ROOT, ".env.local"), rootEnv);
  ensureEnvFile(join(ROOT, "apps", "web", ".env.local"), webEnv);
}

function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = httpRequest(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function waitReady(url, label, attempts = 120, intervalMs = 1000) {
  for (let i = 1; i <= attempts; i++) {
    if (await probe(url)) {
      log(`${label} 已就绪（第 ${i} 次探测）`);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${label} 等待超时：${url}`);
}

function startChild(name, command, args) {
  log(`启动 ${name}…`);
  const child = spawn(command, args, {
    cwd: ROOT,
    shell: IS_WIN,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

async function main() {
  prepareEnvFiles();

  // 1) mock Supabase（54321）
  if (await probe(MOCK_URL)) {
    log("54321 已有服务，复用现有 mock");
  } else {
    startChild("mock", process.execPath, [
      join("scripts", "本地mock-supabase.mjs"),
    ]);
    await waitReady(MOCK_URL, "mock Supabase");
  }

  // 2) API Server（3001）
  if (await probe(SERVER_HEALTH)) {
    log("3001 已有服务，复用现有 API Server");
  } else {
    startChild("server", "pnpm", ["--filter", "@loomic/server", "dev:server"]);
    await waitReady(SERVER_HEALTH, "API Server");
  }

  // 3) Web（3000）
  if (await probe(WEB_URL)) {
    log("3000 已有服务，复用现有 Web");
  } else {
    startChild("web", "pnpm", ["--filter", "@loomic/web", "dev"]);
    await waitReady(WEB_URL, "Web");
  }

  console.log("");
  log("本地环境全部就绪：");
  console.log("  工作台  http://localhost:3000  （/ 自动进入工作台）");
  console.log("  登录页  http://localhost:3000/login");
  console.log("  测试登录：任意邮箱 + 任意密码（mock 签发本地会话）");
  console.log("  按 Ctrl+C 退出（复用的服务不会被杀掉）");
}

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill();
    }
  }
}

process.on("SIGINT", () => {
  log("收到退出信号，正在关闭子服务…");
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

main().catch((err) => {
  console.error(`[dev:local] 启动失败：${err.message}`);
  cleanup();
  process.exit(1);
});
