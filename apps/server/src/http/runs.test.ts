import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerRunRoutes } from "./runs.js";

/**
 * `GET /api/agent/subagents`（设置 →「子智能体」的数据源）的**路由级**回归。
 *
 * 这一层的价值在于契约形状：响应要过 `agentSubagentListResponseSchema`，客户端据此渲染
 * （漏字段/多字段都会被 zod 拦下或剥掉）。同时钉住「未登录不给清单」这条基本线。
 */
const USER = {
  accessToken: "tok",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

function buildApp(authenticated: boolean) {
  const app = Fastify();
  void registerRunRoutes(app, {} as never, {
    auth: {
      authenticate: async () => (authenticated ? USER : null),
      resolveUser: async () => null,
    } as never,
  });
  return app;
}

describe("GET /api/agent/subagents", () => {
  it("登录后返回声明的子代理与内置分发工具（形状过契约）", async () => {
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

  it("未登录：401（清单不外泄）", async () => {
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
