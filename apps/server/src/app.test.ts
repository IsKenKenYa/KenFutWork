import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

/**
 * buildApp 装配完整性回归：所有 feature 插件的认证门路由必须真实注册。
 * 用未认证请求探针：401 = 路由已注册且过认证门；404 = 插件漏挂载（装配回归）。
 * 背景：P3 迁移中曾出现「路由手工注册已删、插件却未接入内核清单」的静默漏挂载，
 * 该测试把 11 个 feature 的装配完整性锁死。
 */
const AUTH_GATED_PROBES = [
  { method: "GET", url: "/api/brand-kits" },
  { method: "GET", url: "/api/credits" },
  { method: "GET", url: "/api/jobs" },
  { method: "GET", url: "/api/projects" },
  { method: "GET", url: "/api/skills" },
  { method: "GET", url: "/api/workspaces/skills" },
  { method: "GET", url: "/api/viewer" },
  { method: "POST", url: "/api/agent/runs" },
  { method: "GET", url: "/api/workspace/settings" },
  { method: "GET", url: "/api/provider-instances" },
  { method: "GET", url: "/api/model-catalog" },
  { method: "GET", url: "/api/usage/summary" },
  // 平台管理后台（FORM-10）：探针只断言「已装配」（非 404）；
  // 未认证 401 / 非管理员 403 的判定由 admin-service 单测覆盖。
  { method: "GET", url: "/api/admin/me" },
  { method: "GET", url: "/api/admin/users" },
  { method: "GET", url: "/api/admin/usage" },
  { method: "GET", url: "/api/admin/providers" },
] as const;

/** 无认证门但必须装配的路由（注册完整性用 200 探针）。 */
const PUBLIC_GET_ROUTES = [
  "/api/health",
  "/api/models",
  "/api/image-models",
  "/api/video-models",
] as const;

function buildProbeApp() {
  return buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/loomic-test",
      // blob 缝是必需能力且只有本地 FS 形态（M1.5 已删 Supabase Provider）
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      credentialSecret: "test-secret",
    },
    overrides: { auth: { authenticate: async () => null } },
  });
}

describe("buildApp 装配完整性（插件清单防漏挂）", () => {
  it("全部 feature 路由已装配：探针返回 400/401 等，唯独不允许 404", async () => {
    const app = buildProbeApp();
    try {
      for (const probe of AUTH_GATED_PROBES) {
        const response = await app.inject(probe);
        expect(
          response.statusCode,
          `${probe.method} ${probe.url} 未按预期装配（返回 404）`,
        ).not.toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it("缺 databaseUrl 时启动期 fail loud（存储缝是必需项，不再静默降级）", () => {
    expect(() =>
      buildApp({
        // blob 配置给全，让「缺 databaseUrl」成为唯一的失败原因
        env: {
          blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
          credentialSecret: "test-secret",
        },
        overrides: { auth: { authenticate: async () => null } },
      }),
    ).toThrow(/persistence/);
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
