import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createMemoryTaskWorkManager } from "./features/task-work/test-store.js";
import { createStartupPersistenceFixture } from "./test-startup-persistence.js";

/**
 * buildApp 装配完整性回归：所有 feature 插件的认证门路由必须真实注册。
 * 用未授权请求探针：401 = 路由已注册且过本机接入门；404 = 插件漏挂载。
 * 背景：P3 迁移中曾出现「路由手工注册已删、插件却未接入内核清单」的静默漏挂载，
 * 本机功能必须真实挂载；退役账户和商业功能必须返回 404。
 */
const AUTH_GATED_PROBES = [
  { method: "GET", url: "/api/brand-kits" },
  { method: "GET", url: "/api/jobs" },
  { method: "GET", url: "/api/projects" },
  { method: "GET", url: "/api/skills" },
  { method: "GET", url: "/api/instance/skills" },
  { method: "GET", url: "/api/instance" },
  {
    method: "POST",
    url: "/api/agent/runs",
    payload: {
      sessionId: "session-1",
      conversationId: "conversation-1",
      prompt: "hello",
    },
  },
  { method: "GET", url: "/api/instance/settings" },
  { method: "GET", url: "/api/local-access/clients" },
  { method: "GET", url: "/api/models" },
  { method: "GET", url: "/api/provider-instances" },
  { method: "GET", url: "/api/model-catalog" },
  { method: "GET", url: "/api/usage/summary" },
] as const;

const RETIRED_PROBES = [
  { method: "GET", url: "/api/viewer" },
  { method: "GET", url: "/api/credits" },
  { method: "POST", url: "/api/auth/login" },
  { method: "POST", url: "/api/auth/register" },
  { method: "GET", url: "/api/payments/plans" },
  { method: "GET", url: "/api/admin/me" },
  { method: "GET", url: "/api/admin/users" },
  { method: "GET", url: "/api/admin/usage" },
  { method: "GET", url: "/api/admin/providers" },
] as const;

/** 无认证门但必须装配的路由（注册完整性用 200 探针）。 */
const PUBLIC_GET_ROUTES = ["/api/health"] as const;

function buildProbeApp() {
  const persistence = createStartupPersistenceFixture();
  return buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/kenfutwork-test",
      // blob 缝是必需能力且只有本地 FS 形态（M1.5 已删 Supabase Provider）
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      desktopDataDir: persistence.dataDir,
    },
    overrides: {
      taskWork: createMemoryTaskWorkManager(),
      persistence,
    },
  });
}

describe("buildApp 装配完整性（插件清单防漏挂）", () => {
  it("全部本机 feature 路由已装配且拒绝无凭据请求", async () => {
    const app = buildProbeApp();
    try {
      for (const probe of AUTH_GATED_PROBES) {
        const response = await app.inject(probe);
        expect(
          response.statusCode,
          `${probe.method} ${probe.url} 未通过本机接入门`,
        ).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it("账户、管理员与商业路由均已退役", async () => {
    const app = buildProbeApp();
    try {
      await app.ready();
      const token = await app.kernel.get("localAccess").getDesktopToken();
      for (const probe of RETIRED_PROBES) {
        const response = await app.inject({
          ...probe,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode, `${probe.method} ${probe.url}`).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("缺 databaseUrl 时启动期 fail loud（存储缝是必需项，不再静默降级）", () => {
    // 本例断言「未配置即失败」，故必须屏蔽进程环境里可能存在的连接串：
    // 集成测试会带着 DATABASE_URL 跑整套用例，否则这里会因环境泄漏假失败。
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("KENFUTWORK_DATABASE_URL", "");
    try {
      expect(() =>
        buildApp({
          // blob 配置给全，让「缺 databaseUrl」成为唯一的失败原因
          env: {
            blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
          },
          overrides: {
            taskWork: createMemoryTaskWorkManager(),
          },
        }),
      ).toThrow(/persistence/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("公开路由不设认证门但必须装配：200 而非 404", async () => {
    const app = buildProbeApp();
    try {
      for (const url of PUBLIC_GET_ROUTES) {
        const response = await app.inject({ method: "GET", url });
        expect(
          response.statusCode,
          `${url} 未按预期装配（期望 200，实际 ${response.statusCode}）`,
        ).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
