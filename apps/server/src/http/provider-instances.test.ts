import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { createMemoryTaskWorkManager } from "../features/task-work/test-store.js";
import { createStartupPersistenceFixture } from "../test-startup-persistence.js";

/**
 * 供应商实例自定义请求头的 **HTTP 边界**回归（§4.8）：
 * 服务层与契约层各有单测，但「路由是否真的把 headers 交给服务、是否把 schema 的
 * fail loud 变成 4xx」只有真发请求才看得到——这条曾被历史漏挂载坑过（见 app.test.ts）。
 */

const USER = {
  accessToken: "tok",
  email: "u@example.com",
  id: "user-1",
  userMetadata: {},
};

function buildHttpApp() {
  const createInstance = vi.fn(async (_user: unknown, input: unknown) => ({
    id: "inst-1",
    scope: "workspace" as const,
    name: (input as { name: string }).name,
    protocol: (input as { protocol: string }).protocol,
    hasCredential: true,
    configRevision: 1,
    models: [{ id: "m1", name: "M1", capability: "chat" as const }],
    headerKeys: Object.keys((input as { headers?: object }).headers ?? {}),
    enabled: true,
  }));

  const app = buildApp({
    env: {
      databaseUrl: "postgres://localhost:5432/loomic-test",
      blobDir: "D:/Desktop/KenFutWork/data/blobs-test",
      credentialSecret: "test-secret",
    },
    overrides: {
      taskWork: createMemoryTaskWorkManager(),
      persistence: createStartupPersistenceFixture(),
      auth: {
        authenticate: async () => USER,
        resolveUser: async () => USER,
      } as never,
      modelProviders: {
        createInstance,
        listInstances: async () => [],
      } as never,
    },
  });

  return { app, createInstance };
}

describe("POST /api/provider-instances 自定义请求头（HTTP 边界）", () => {
  it("携带 headers 透传到服务，响应只回 headerKeys", async () => {
    const { app, createInstance } = buildHttpApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/provider-instances",
        payload: {
          name: "opencode",
          protocol: "openai-compatible",
          apiKey: "sk-1",
          models: [{ id: "m1", name: "M1", capability: "chat" }],
          headers: { "x-opencode-session": "{{sessionId}}" },
        },
      });

      expect(response.statusCode, response.body).toBe(201);
      expect(createInstance).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          headers: { "x-opencode-session": "{{sessionId}}" },
        }),
      );
      expect(response.json().headerKeys).toEqual(["x-opencode-session"]);
      // 值不回显
      expect(response.body).not.toContain("{{sessionId}}");
    } finally {
      await app.close();
    }
  });

  it("保留头 / CRLF 注入 / 白名单外占位符：写入时即拒（4xx，不落库）", async () => {
    const { app, createInstance } = buildHttpApp();
    const base = {
      name: "opencode",
      protocol: "openai-compatible",
      apiKey: "sk-1",
      models: [{ id: "m1", name: "M1", capability: "chat" }],
    };
    try {
      for (const headers of [
        { Authorization: "Bearer sk-evil" },
        { "x-opencode-session": "a\r\nX-Evil: 1" },
        { "x-tenant": "{{workspaceId}}" },
        { "Content-Type": "text/plain" },
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/provider-instances",
          payload: { ...base, headers },
        });
        expect(
          response.statusCode,
          JSON.stringify(headers),
        ).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
      }
      expect(createInstance).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
