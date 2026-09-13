import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { loadServerEnv } from "../config/env.js";
import { prepareDesktopRuntime } from "./runtime.js";

/**
 * 桌面运行时真实启动测试（FORM-2）。默认 skipped：需要显式开启。
 *
 *   LOOMIC_DESKTOP_PG_IT=1 pnpm --filter @loomic/server exec vitest run desktop-runtime.integration
 *
 * 这条用例是 M2.3 的「开箱即用」验收：一个空数据目录 → 拉起内嵌 Postgres →
 * 跑完 40 条迁移 → 起 HTTP → **不带任何令牌**访问受保护接口成功（local-trust）→
 * 认证路由不存在（免登录形态不保留口令攻击面）→ 关停后停库。
 */
const ENABLED = process.env.LOOMIC_DESKTOP_PG_IT === "1";

describe.skipIf(!ENABLED)("桌面运行时（内嵌 PG + local-trust）", () => {
  it("空目录首启动即建成完整 schema，且免登录可用", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const repoRoot = join(process.cwd(), "..", "..");
    const dataDir = await mkdtemp(join(tmpdir(), "loomic-desktop-runtime-"));
    const logs: string[] = [];

    const runtime = await prepareDesktopRuntime({
      env: loadServerEnv({
        authDriver: "local-trust",
        credentialSecret: "desktop-test-secret",
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

      // 1) 免登录：不带 Authorization 也拿到 viewer（本机账号自动引导）
      const viewer = await app.inject({ method: "GET", url: "/api/viewer" });
      expect(viewer.statusCode).toBe(200);
      const viewerBody = viewer.json<{
        profile: { displayName: string; id: string };
        workspace: { type: string };
      }>();
      expect(viewerBody.workspace.type).toBe("personal");
      expect(viewerBody.profile.id).toBeTruthy();

      // 2) 其它受保护接口同样免登录可用
      for (const url of ["/api/models", "/api/projects", "/api/credits"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode, url).toBe(200);
      }

      // 3) 免登录形态不挂口令认证路由（不保留无人使用的攻击面）
      const login = await app.inject({
        body: { email: "x@y.test", password: "irrelevant" },
        method: "POST",
        url: "/api/auth/login",
      });
      expect(login.statusCode).toBe(404);

      // 4) 外来源页面被拒（防用户浏览器里的网页借本机端口读数据）
      const foreign = await app.inject({
        headers: { origin: "https://evil.example.com" },
        method: "GET",
        url: "/api/viewer",
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
