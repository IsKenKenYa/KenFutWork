import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { loadServerEnv } from "../config/env.js";
import { prepareDesktopRuntime } from "./runtime.js";

/**
 * 桌面运行时真实启动测试（FORM-2）。默认 skipped：需要显式开启。
 *
 *   KENFUTWORK_DESKTOP_PG_IT=1 pnpm --filter @kenfutwork/server exec vitest run desktop-runtime.integration
 *
 * 这条用例是 M2.3 的「开箱即用」验收：一个空数据目录 → 拉起内嵌 Postgres →
 * 跑完同源迁移 → 起HTTP → 私有桌面凭据换一次性浏览器cookie →
 * 无账户且有真实接入校验 → 关停后停库。
 */
const ENABLED = process.env.KENFUTWORK_DESKTOP_PG_IT === "1";

describe.skipIf(!ENABLED)("桌面运行时（内嵌PG + 本机接入）", () => {
  it("空目录首启动即建成完整 schema，且免登录可用", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const repoRoot = join(process.cwd(), "..", "..");
    const dataDir = await mkdtemp(
      join(tmpdir(), "kenfutwork-desktop-runtime-"),
    );
    const logs: string[] = [];

    const runtime = await prepareDesktopRuntime({
      env: loadServerEnv({
        desktopDataDir: dataDir,
        embeddedPostgres: true,
        serverHost: "127.0.0.1",
        webOrigin: "http://127.0.0.1:3001",
      }),
      exeDir: join(dataDir, "nope"),
      onLog: (message) => logs.push(message),
      repoRoot,
    });
    const app = buildApp({ env: runtime.env });

    try {
      // 首启动建库 + 全量迁移（日志里应有迁移执行行）
      expect(logs.some((line) => line.includes("已执行迁移"))).toBe(true);

      await app.ready();
      const token = await app.kernel.get("localAccess").getDesktopToken();
      const headers = { authorization: `Bearer ${token}` };
      const missing = await app.inject({ method: "GET", url: "/api/instance" });
      expect(missing.statusCode).toBe(401);
      const instance = await app.inject({
        method: "GET",
        url: "/api/instance",
        headers,
      });
      expect(instance.statusCode).toBe(200);
      expect(instance.json().dataDir).toBe(dataDir);
      expect(instance.json().instanceId).toMatch(/^[0-9a-f-]{36}$/);

      // 2) 其它受保护接口同样免登录可用
      for (const url of ["/api/models", "/api/projects"]) {
        const response = await app.inject({ method: "GET", url, headers });
        expect(response.statusCode, url).toBe(200);
      }

      // 3) 免登录形态不挂口令认证路由（不保留无人使用的攻击面）
      for (const url of ["/api/viewer", "/api/credits", "/api/auth/login"]) {
        expect(
          (await app.inject({ method: "GET", url, headers })).statusCode,
        ).toBe(404);
      }

      const issued = await app.inject({
        method: "POST",
        url: "/api/local-access/tickets",
        headers,
        payload: {},
      });
      expect(issued.statusCode).toBe(201);
      const connected = await app.inject({
        method: "POST",
        url: "/api/local-access/connect",
        payload: { ticket: issued.json().ticket },
      });
      expect(connected.statusCode).toBe(200);
      expect(connected.json().instanceId).toBe(instance.json().instanceId);
      expect(connected.json()).not.toHaveProperty("token");
      const cookieHeader = connected.headers["set-cookie"];
      if (typeof cookieHeader !== "string")
        throw new Error("未签发浏览器cookie。");
      const browser = await app.inject({
        method: "GET",
        url: "/api/instance",
        headers: { cookie: cookieHeader.split(";")[0] ?? "" },
      });
      expect(browser.statusCode).toBe(200);
      expect(browser.json()).toEqual(instance.json());

      // 4) 外来源页面被拒（防用户浏览器里的网页借本机端口读数据）
      const foreign = await app.inject({
        headers: { ...headers, origin: "https://evil.example.com" },
        method: "GET",
        url: "/api/instance",
      });
      // CORS 钩子先于认证挡下跨源请求，故是 403（比 401 更早、更明确）
      expect(foreign.statusCode).toBe(403);
    } finally {
      await app.close();
      await runtime.shutdown();
      await rm(dataDir, { force: true, recursive: true });
    }
  }, 240_000);
});
