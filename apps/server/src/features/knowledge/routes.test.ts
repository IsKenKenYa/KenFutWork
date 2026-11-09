/**
 * HTTP 路由回归测试。
 *
 * 刻意放在 `features/knowledge/` 而不是 `http/`：`tests/api-spec-consistency.test.mjs`
 * 会扫描 `http/*.ts` 里的 `app.get("/api/...")` 字面量，测试文件放进去会被误当成
 * 真实路由注册，导致 spec 漂移门禁红灯。
 */

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerKnowledgeRoutes } from "../../http/knowledge.js";
import type { SettingsService } from "../settings/settings-service.js";
import type { KnowledgeSettingsReader } from "./settings.js";
import { type KnowledgeService, KnowledgeServiceError } from "./types.js";

const actor = { instanceId: "instance-1", accessClientId: null };

function stub(overrides: Partial<KnowledgeService> = {}): KnowledgeService {
  return {
    isActive: async () => ({ ok: true, message: "" }),
    status: async () => ({
      installed: true,
      enabled: true,
      active: true,
      cli: "available",
      cliVersion: "0.1.8",
      reason: null,
    }),
    initialize: async () => ({
      ok: true,
      credential: "reused",
      cli: "available",
      reason: null,
    }),
    listRoots: async () => [
      {
        path: "D:/work/project",
        name: "project",
        status: "ready",
        count: 3,
        error: null,
      },
    ],
    addRoot: async (input) => ({
      path: input.path,
      indexStatus: "ready",
      cliAuthorized: true,
    }),
    removeRoot: async (path) => ({ path }),
    ensureRoot: async (path) => ({ path, action: "already-indexed" }),
    search: async () => ({
      scope: "D:/work/project",
      results: [
        {
          path: "src/client.ts",
          absolutePath: "D:/work/project/src/client.ts",
          startLine: 142,
          endLine: 158,
          content: "retry();",
        },
      ],
      truncated: false,
    }),
    read: async (input) => ({
      path: input.path,
      content: "retry();",
      truncated: false,
    }),
    rootsRevision: () => 1,
    ...overrides,
  } as KnowledgeService;
}

const settings: Awaited<ReturnType<KnowledgeSettingsReader>> = {
  autoInject: true,
  localMatch: false,
  autoLocalFallback: true,
  maxResults: 5,
  minHits: 1,
  searchTimeoutMs: 30_000,
  maxConcurrentSearches: 2,
  evidenceMaxChars: 6_000,
  cacheTtlMs: 300_000,
  readMaxBytes: 1_048_576,
  listTimeoutMs: 120_000,
  listRetries: 1,
};

async function appWith(
  knowledge: KnowledgeService,
  authenticated = true,
  extra: {
    readSettings?: KnowledgeSettingsReader;
    settings?: Pick<SettingsService, "updateInstanceSettings">;
  } = {},
) {
  const app = Fastify({ logger: false });
  await registerKnowledgeRoutes(app, {
    localAccess: {
      authenticate: async () => (authenticated ? actor : null),
    },
    localInstance: { resolve: async () => undefined },
    knowledge,
    ...extra,
  });
  return app;
}

describe("GET /api/knowledge/status", () => {
  it("返回状态契约", async () => {
    const app = await appWith(stub());
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      active: true,
      cli: "available",
      cliVersion: "0.1.8",
    });
    await app.close();
  });

  it("未认证返回 401，且错误码是契约里的 unauthorized", async () => {
    const app = await appWith(stub(), false);
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/status",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
    await app.close();
  });
});

describe("知识库根与检索路由", () => {
  it("GET /roots 返回根目录列表", async () => {
    const app = await appWith(stub());
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/roots",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().roots[0].path).toBe("D:/work/project");
    await app.close();
  });

  it("POST /roots 与 /roots/remove 走契约校验并回写结果", async () => {
    const app = await appWith(stub());
    const added = await app.inject({
      method: "POST",
      url: "/api/knowledge/roots",
      payload: { path: "D:/work/project", types: ["md", "ts"] },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({
      path: "D:/work/project",
      indexStatus: "ready",
    });

    const removed = await app.inject({
      method: "POST",
      url: "/api/knowledge/roots/remove",
      payload: { path: "D:/work/project" },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ path: "D:/work/project" });
    await app.close();
  });

  it("POST /search 返回归一化证据", async () => {
    const app = await appWith(stub());
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge/search",
      payload: { query: "重试逻辑", maxResults: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toMatchObject({
      path: "src/client.ts",
      startLine: 142,
      endLine: 158,
    });
    await app.close();
  });

  it("非法请求体返回 400 / invalid_input，不触达服务", async () => {
    const search = {
      fn: async () => ({ scope: "", results: [], truncated: false }),
    };
    const app = await appWith(stub({ search: search.fn }));
    for (const payload of [
      { query: "" },
      { query: "x".repeat(2001) },
      { query: "ok", maxResults: 101 },
      {},
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/knowledge/search",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_input");
    }
    const badRoot = await app.inject({
      method: "POST",
      url: "/api/knowledge/roots",
      payload: { path: "" },
    });
    expect(badRoot.statusCode).toBe(400);
    await app.close();
  });

  it("服务不可用映射成 503 / service_unavailable，不泄漏堆栈", async () => {
    const app = await appWith(
      stub({
        search: async () => {
          throw new KnowledgeServiceError(
            "service_unavailable",
            "SAG CLI 不可用",
          );
        },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge/search",
      payload: { query: "x" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual({
      code: "service_unavailable",
      message: "SAG CLI 不可用",
    });
    await app.close();
  });

  it("未预期的异常收敛成 application_error，不把内部错误原文塞给前端", async () => {
    const app = await appWith(
      stub({
        listRoots: async () => {
          throw new Error("内部细节");
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/roots",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("application_error");
    await app.close();
  });

  it("POST /search 沿用实例设置：本地匹配档/超时/条数（真机回归）", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = await appWith(
      stub({
        search: async (input) => {
          calls.push({ ...input });
          return { scope: "", results: [], truncated: false };
        },
      }),
      true,
      {
        readSettings: async () => ({
          ...settings,
          localMatch: true,
          maxResults: 3,
          searchTimeoutMs: 12_000,
        }),
      },
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge/search",
      payload: { query: "林远" },
    });
    expect(response.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      localMatch: true,
      maxResults: 3,
      timeoutMs: 12_000,
    });
    await app.close();
  });
});

describe("M4：read 与 settings 路由", () => {
  it("GET /read 按查询参数取原文并传读取预算", async () => {
    const reads: Array<Record<string, unknown>> = [];
    const app = await appWith(
      stub({
        read: async (input) => {
          reads.push({ ...input });
          return {
            path: input.path,
            content: "第二行\n第三行",
            truncated: false,
          };
        },
      }),
      true,
      { readSettings: async () => settings },
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/read?path=D%3A%2Fkb%2Fa.md&startLine=2&endLine=3",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      path: "D:/kb/a.md",
      content: "第二行\n第三行",
      truncated: false,
    });
    expect(reads[0]).toMatchObject({
      path: "D:/kb/a.md",
      startLine: 2,
      endLine: 3,
      maxBytes: settings.readMaxBytes,
    });
    await app.close();
  });

  it("GET /read 缺少 path 返回 400", async () => {
    const app = await appWith(stub(), true, {
      readSettings: async () => settings,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/read",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_input");
    await app.close();
  });

  it("GET /settings 返回当前实例设置；最小装配显式 503", async () => {
    const app = await appWith(stub(), true, {
      readSettings: async () => settings,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/knowledge/settings",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ autoInject: true, maxResults: 5 });

    const minimal = await appWith(stub());
    const unavailable = await minimal.inject({
      method: "GET",
      url: "/api/knowledge/settings",
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe("service_unavailable");
    await app.close();
    await minimal.close();
  });

  it("POST /settings 把面板字段映射成实例治理键并回读", async () => {
    const writes: Array<{
      instanceId: string;
      patch: Record<string, unknown>;
    }> = [];
    const app = await appWith(stub(), true, {
      readSettings: async () => settings,
      settings: {
        updateInstanceSettings: async (_actor, instanceId, patch) => {
          writes.push({ instanceId, patch: patch as Record<string, unknown> });
          return {} as never;
        },
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/knowledge/settings",
      payload: {
        autoInject: false,
        localMatch: true,
        maxResults: 9,
        evidenceMaxChars: 4096,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().autoInject).toBe(true); // 回读的是存储后的真值（fixture 未变）
    expect(writes).toEqual([
      {
        instanceId: actor.instanceId,
        patch: {
          knowledgeAutoInject: false,
          knowledgeLocalMatch: true,
          knowledgeMaxResults: 9,
          knowledgeEvidenceMaxChars: 4096,
        },
      },
    ]);
    await app.close();
  });

  it("POST /settings 空更新返回 400，非法类型不触达服务", async () => {
    const app = await appWith(stub(), true, {
      readSettings: async () => settings,
      settings: {
        updateInstanceSettings: async () => {
          throw new Error("不应触达");
        },
      },
    });
    const empty = await app.inject({
      method: "POST",
      url: "/api/knowledge/settings",
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
    const bad = await app.inject({
      method: "POST",
      url: "/api/knowledge/settings",
      payload: { maxResults: "很多" },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
