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
    env: { supabaseDbUrl: "postgres://localhost:5432/loomic-test" },
    auth: { authenticate: async () => null },
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

  it("无 supabaseDbUrl 时 jobs 路由不装配（404），其余 feature 不受影响", async () => {
    const app = buildApp({
      auth: { authenticate: async () => null },
    });
    try {
      const jobs = await app.inject({ method: "GET", url: "/api/jobs" });
      expect(jobs.statusCode).toBe(404);
      const viewer = await app.inject({ method: "GET", url: "/api/viewer" });
      expect(viewer.statusCode).toBe(401);
    } finally {
      await app.close();
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
