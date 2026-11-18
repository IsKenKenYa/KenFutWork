import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * KenFutWork 端到端测试配置。
 *
 * 真实启动两个进程：server（Fastify + 嵌入式 Postgres）与 web（Next dev）。
 * 数据目录与 PG 端口都放在仓库 `.scratch/e2e-data`（已被 .gitignore 忽略），
 * 不复用桌面的数据目录，也不复用 54329 端口。
 *
 * 服务端保持 3001、web 保持 3000：`apps/web/next.config.ts` 的开发代理把
 * `/api/:path*` 固定转发到 `127.0.0.1:3001`，换端口会让同源代理失联。
 * 浏览器侧 origin 用 `http://localhost:3000`，与 server `DEFAULT_WEB_ORIGIN` 一致。
 */
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(repoRoot, ".scratch", "e2e-data");

const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);

const serverEnv = {
  ...inheritedEnv,
  KENFUTWORK_DATA_DIR: dataDir,
  KENFUTWORK_EMBEDDED_PG_PORT: "54330",
  KENFUTWORK_SERVER_PORT: "3001",
  KENFUTWORK_WEB_ORIGIN: "http://localhost:3000",
};

export default defineConfig({
  testDir: path.join(import.meta.dirname, "tests"),
  outputDir: path.join(repoRoot, ".scratch", "e2e", "results"),
  // 所有用例共用同一实例与同一份设置数据，串行跑避免互相覆盖。
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.join(repoRoot, ".scratch", "e2e", "report"),
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "zh-CN",
    // 用完整 chromium（新 headless），不用 headless shell：后者在本机不驱动
    // requestAnimationFrame，会让依赖双 rAF 的启动层永不摘除。
    channel: "chromium",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      // 不用 dev:server 的 `node --watch`：watch 在 web 构建期间会重启服务端，
      // 造成页面接入时瞬间 ECONNREFUSED。这里按同一入口直接起服务端进程。
      command: "node --env-file=../../.env.local --import tsx ./src/server.ts",
      cwd: path.join(repoRoot, "apps", "server"),
      url: "http://127.0.0.1:3001/api/health",
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: serverEnv,
    },
    {
      command: "pnpm --filter @kenfutwork/web dev",
      cwd: repoRoot,
      url: "http://localhost:3000/workbench",
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...inheritedEnv, KENFUTWORK_SERVER_PORT: "3001" },
    },
  ],
});
