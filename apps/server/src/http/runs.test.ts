import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeTestInstance,
  RUNTIME_TEST_ACTOR,
} from "../agent/runtime-test-fixtures.js";

import { registerRunRoutes } from "./runs.js";

/**
 * `GET /api/agent/subagents`（设置 →「子智能体」的数据源）的**路由级**回归。
 *
 * 这一层的价值在于契约形状：响应要过 `agentSubagentListResponseSchema`，客户端据此渲染
 * （漏字段/多字段都会被 zod 拦下或剥掉）。同时钉住「未授权不给清单」这条基本线。
 */
function buildApp(authenticated: boolean, deps: Partial<Parameters<typeof registerRunRoutes>[2]> = {}) {
  const app = Fastify();
  void registerRunRoutes(app, {} as never, {
    localAccess: {
      authenticate: async () => (authenticated ? RUNTIME_TEST_ACTOR : null),
    },
    localInstance: createRuntimeTestInstance(),
    ...deps,
  });
  return app;
}

describe("GET /api/agent/subagents", () => {
  it("本机授权后返回声明的子代理与内置分发工具（形状过契约）", async () => {
    const app = buildApp(true);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        subagents: Array<{ name: string; label: string; tools: string[] }>;
        builtin: Array<{ name: string }>;
      };
      expect(body.subagents.map((entry) => entry.name)).toContain(
        "video_generate",
      );
      expect(body.builtin.map((entry) => entry.name)).toContain("task");
      // 中文短名与工具名都要在（界面直接上屏，缺了就是空白行）
      for (const entry of body.subagents) {
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.tools.length).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
    }
  });

  it("未获本机授权：401（清单不外泄）", async () => {
    const app = buildApp(false);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/agent/subagents",
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});


describe("最新 Run 的本机查询", () => {
  it("只用持久会话与实例归属查询并返回原始失败原因", async () => {
    const latestRunQuery = vi.fn(async () => ({
      status: "failed", errorCode: "run_failed", errorMessage: "服务重启，本轮已中断。",
      startedAt: "2026-10-07T00:00:00.000Z", completedAt: null,
    }));
    const app = buildApp(true, { latestRunQuery });
    try {
      const response = await app.inject({ url: "/api/agent/runs/latest?sessionId=persistent-session" });
      expect(response.statusCode).toBe(200);
      expect(response.json().run.errorMessage).toBe("服务重启，本轮已中断。");
      expect(latestRunQuery).toHaveBeenCalledWith({ sessionId: "persistent-session", instanceId: RUNTIME_TEST_ACTOR.instanceId });
      expect((await app.inject({ url: "/api/agent/runs/latest" })).json()).toEqual({ run: null });
      expect(latestRunQuery).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("未认证请求不会读取终态", async () => {
    const latestRunQuery = vi.fn();
    const app = buildApp(false, { latestRunQuery });
    try {
      expect((await app.inject({ url: "/api/agent/runs/latest?sessionId=other" })).statusCode).toBe(401);
      expect(latestRunQuery).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
