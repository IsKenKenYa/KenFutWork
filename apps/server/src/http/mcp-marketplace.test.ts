import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalActor } from "../features/local-instance/types.js";
import { ClaudeMarketplaceError } from "../features/mcp/claude-marketplace.js";
import type { ClaudeMarketplaceService } from "../features/mcp/claude-marketplace-service.js";
import { registerMcpRoutes } from "./mcp.js";

const ACTOR: LocalActor = Object.freeze({
  instanceId: "00000000-0000-4000-8000-0000000000a1",
  accessClientId: null,
});

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** 市场替身：只提供路由用得到的三件事（read / refresh / find）。 */
function marketplaceStub(options: { found?: boolean; addable?: boolean } = {}) {
  const calls: string[] = [];
  const snapshot = {
    marketplace: { name: "claude-plugins-official", owner: "Anthropic" },
    state: "ready" as const,
    refreshing: false,
    checked: 3,
    total: 3,
    unreadable: 0,
    completedAt: 1_700_000_000_000,
    servers: [
      {
        id: "neon:neon",
        serverName: "neon",
        suggestedName: "neon",
        plugin: "neon",
        pluginTitle: "neon",
        description: "Neon 数据库",
        author: null,
        category: "database",
        homepage: null,
        kind: "http" as const,
        summary: "https://mcp.neon.tech/mcp",
        inputs: [],
        addable: options.addable ?? true,
        unsupportedReason:
          (options.addable ?? true) ? null : "要登录授权才能连接",
      },
    ],
    message: null,
    unreadablePlugins: [{ plugin: "x", reason: "内部细节" }],
  };
  const service: ClaudeMarketplaceService = {
    read() {
      calls.push("read");
      return snapshot;
    },
    refresh() {
      calls.push("refresh");
      return { ...snapshot, refreshing: true };
    },
    find(id: string) {
      calls.push(`find:${id}`);
      if (options.found === false) {
        throw new ClaudeMarketplaceError(
          "这个服务不在当前市场结果里，请刷新市场后再试。",
        );
      }
      // 与真实实现一致：不可添加的条目没有模板
      const first = snapshot.servers[0];
      if (!first) throw new Error("夹具缺服务");
      return {
        view: first,
        template:
          options.addable === false
            ? null
            : {
                kind: "http",
                command: null,
                args: [],
                env: {},
                url: "https://mcp.neon.tech/mcp",
                headers: {},
                variables: new Map(),
              },
      };
    },
    shutdown() {},
  };
  return { service, calls };
}

async function fixture(
  options: {
    marketplace?: boolean;
    found?: boolean;
    addable?: boolean;
    createError?: Error;
    unauthenticated?: boolean;
  } = {},
) {
  const app = Fastify({ logger: false });
  cleanups.push(() => void app.close());
  const created: unknown[] = [];
  const stub = marketplaceStub({
    ...(options.found !== undefined ? { found: options.found } : {}),
    ...(options.addable !== undefined ? { addable: options.addable } : {}),
  });
  await registerMcpRoutes(app, {
    localAccess: {
      authenticate: async () => (options.unauthenticated ? null : ACTOR),
    } as never,
    localInstance: { resolve: async () => ACTOR } as never,
    service: {
      create: async (input: unknown) => {
        if (options.createError) throw options.createError;
        created.push(input);
        return { name: (input as { name: string }).name };
      },
    } as never,
    ...(options.marketplace === false ? {} : { marketplace: stub.service }),
  });
  return { app, created, calls: stub.calls };
}

describe("MCP 市场路由", () => {
  it("未授权一律 401", async () => {
    const { app } = await fixture({ unauthenticated: true });
    const response = await app.inject({
      method: "get",
      path: "/api/mcp/claude-marketplace",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("unauthorized");
  });

  it("读取市场快照：不下发内部的读取失败细节", async () => {
    const { app, calls } = await fixture();
    const response = await app.inject({
      method: "get",
      path: "/api/mcp/claude-marketplace",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0].id).toBe("neon:neon");
    expect(body.unreadablePlugins).toBeUndefined();
    expect(calls).toEqual(["read"]);
  });

  it("refresh=1 走强制重读", async () => {
    const { app, calls } = await fixture();
    const response = await app.inject({
      method: "get",
      path: "/api/mcp/claude-marketplace?refresh=1",
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(["refresh"]);
  });

  it("市场未装配时返回 503，不是空列表", async () => {
    const { app } = await fixture({ marketplace: false });
    const response = await app.inject({
      method: "get",
      path: "/api/mcp/claude-marketplace",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("service_unavailable");
  });

  it("按市场定义添加：用填写值替换变量后落库", async () => {
    const { app, created, calls } = await fixture();
    const response = await app.inject({
      method: "post",
      path: "/api/mcp/claude-marketplace/servers",
      payload: { id: "neon:neon", name: "neon", values: {} },
    });
    expect(response.statusCode).toBe(201);
    expect(calls).toEqual(["find:neon:neon"]);
    expect(created).toEqual([
      {
        name: "neon",
        kind: "http",
        command: undefined,
        args: [],
        url: "https://mcp.neon.tech/mcp",
        env: {},
        headers: {},
        enabled: true,
      },
    ]);
  });

  it("同名已存在返回 409 与可读码（不再变成校验报告）", async () => {
    const { app } = await fixture({
      createError: new Error(
        'duplicate key value violates unique constraint "mcp_servers_name_key"',
      ),
    });
    const response = await app.inject({
      method: "post",
      path: "/api/mcp/claude-marketplace/servers",
      payload: { id: "neon:neon", name: "neon", values: {} },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toEqual({
      code: "mcp_server_exists",
      message: "同名 MCP server 已存在。",
    });
  });

  it("定义不在当前结果里返回 400 与原因", async () => {
    const { app } = await fixture({ found: false });
    const response = await app.inject({
      method: "post",
      path: "/api/mcp/claude-marketplace/servers",
      payload: { id: "missing:x", name: "x", values: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("mcp_marketplace_failed");
    expect(response.json().error.message).toContain("不在当前市场结果里");
  });

  it("不可添加的服务返回 400 与原因", async () => {
    const { app } = await fixture({ addable: false });
    const response = await app.inject({
      method: "post",
      path: "/api/mcp/claude-marketplace/servers",
      payload: { id: "neon:neon", name: "neon", values: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe("要登录授权才能连接");
  });

  it("请求体不合法按期给出原因", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "post",
      path: "/api/mcp/claude-marketplace/servers",
      payload: { id: "neon:neon", name: "带 空格", values: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  });

  it("既有路由的错误码现在都能序列化（此前 401 只有状态码、body 为空）", async () => {
    const unauthenticated = await fixture({ unauthenticated: true });
    const response = await unauthenticated.app.inject({
      method: "delete",
      path: "/api/mcp/servers/00000000-0000-4000-8000-0000000000ff",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toEqual({
      code: "unauthorized",
      message: "本机访问未授权。",
    });
  });
});
