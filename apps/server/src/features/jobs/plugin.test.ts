import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import { composePlugins } from "../../kernel/compose.js";
import type { JobService } from "./job-service.js";
import { createJobsPlugin } from "./plugin.js";

const baseEnv: ServerEnv = {
  agentBackendMode: "state",
  agentModel: "test-model",
  port: 0,
  version: "test",
  webOrigin: "http://localhost:3000",
};

describe("jobs 插件（enabled 条件装配）", () => {
  it("有 databaseUrl 时装配并注册任务路由", async () => {
    const app = Fastify({ logger: false });
    const kernel = composePlugins(
      { ...baseEnv, databaseUrl: "postgres://localhost/test" },
      [createJobsPlugin()],
      {
        app,
        overrides: {
          auth: { authenticate: async () => null },
          credits: {} as never,
          persistence: {} as never,
          // jobs 插件经队列缝投递（M3.2）
          queue: {} as never,
          tierGuard: {} as never,
          viewer: {} as never,
        },
      },
    );
    expect(kernel.tryGet("jobs")).toBeDefined();
    // 路由已注册：未认证请求返回 401 而不是 404
    const response = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(response.statusCode).toBe(401);
    await app.close();
    kernel.dispose();
  });

  it("无 databaseUrl 且无注入实例时不装配，tryGet 返回 undefined", () => {
    const app = Fastify({ logger: false });
    const kernel = composePlugins(baseEnv, [createJobsPlugin()]);
    expect(kernel.tryGet("jobs")).toBeUndefined();
    kernel.dispose();
    void app;
  });

  it("注入实例时无条件装配（保持历史 BuildAppOptions.jobService 行为）", () => {
    const app = Fastify({ logger: false });
    const injected = { markRunning: vi.fn() } as unknown as JobService;
    // 与 app.ts 接线一致：注入实例同时经 overrides 直填，插件工厂不会执行
    const kernel = composePlugins(baseEnv, [createJobsPlugin({ injected })], {
      app,
      overrides: {
        jobs: injected,
        auth: { authenticate: async () => null },
        credits: {} as never,
        persistence: {} as never,
        queue: {} as never,
        tierGuard: {} as never,
        viewer: {} as never,
      },
    });
    expect(kernel.tryGet("jobs")).toBe(injected);
    kernel.dispose();
    void app;
  });
});
