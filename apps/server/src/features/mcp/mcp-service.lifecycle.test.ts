import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import type { ToolDefinition, ToolRegistry } from "../../kernel/types.js";
import { createMcpService } from "./mcp-service.js";
import type { McpServerStore, StoredMcpServer } from "./server-store.js";

/**
 * MCP 生命周期真实链路测试（默认 skipped：需要 node 子进程 + SDK 握手）。
 *
 * 目的：证明「配置 → 起 stdio 进程 → 握手 → listTools → 注册进 ctx.tools →
 * 工具可调用 → 停用/删除后工具**真的被注销**」这条链在真实 MCP 协议下成立。
 * 单测（mcp-service.test.ts）用假 store 覆盖来源合并与失败态，覆盖不到真实
 * 握手与注销——那正是本次新增能力的核心。
 *
 * 运行：KENFUTWORK_MCP_LIFECYCLE=1 pnpm --filter @kenfutwork/server exec vitest run mcp-service.lifecycle
 */
const ENABLED = process.env.KENFUTWORK_MCP_LIFECYCLE === "1";
const FIXTURE = fileURLToPath(
  new URL("../../../scripts/mcp-test-server.mjs", import.meta.url),
);

function fixtureRow(over: Partial<StoredMcpServer> = {}): StoredMcpServer {
  return {
    id: "fixture-1",
    name: "fixture",
    kind: "stdio",
    command: "node",
    url: null,
    args: [FIXTURE],
    env: {},
    headers: {},
    enabled: true,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...over,
  };
}

function inMemoryStore(rows: StoredMcpServer[]): McpServerStore {
  return {
    async list() {
      return rows;
    },
    async listPublic() {
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        command: row.command,
        url: row.url,
        args: row.args,
        envKeys: Object.keys(row.env),
        headerKeys: Object.keys(row.headers),
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
    },
    async findByName(name) {
      return rows.find((row) => row.name === name) ?? null;
    },
    async create(input) {
      const created: StoredMcpServer = {
        id: `id-${input.name}`,
        name: input.name,
        kind: input.kind ?? "stdio",
        command: input.command ?? "",
        args: input.args,
        url: input.url,
        env: input.env,
        headers: input.headers,
        enabled: input.enabled,
        createdAt: "",
        updatedAt: "",
      };
      rows.push(created);
      return created;
    },
    async update(id, patch) {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    async setEnabled(id, enabled) {
      const row = rows.find((item) => item.id === id);
      if (!row) return null;
      row.enabled = enabled;
      return row;
    },
    async remove(id) {
      const index = rows.findIndex((item) => item.id === id);
      if (index < 0) return 0;
      rows.splice(index, 1);
      return 1;
    },
  };
}

function trackingRegistry() {
  const tools = new Map<string, ToolDefinition>();
  const registry = {
    register(definition: ToolDefinition) {
      tools.set(definition.name, definition);
      return () => {
        tools.delete(definition.name);
      };
    },
    get: (name: string) => tools.get(name),
    list: () => [...tools.values()],
  } as unknown as ToolRegistry;
  return { registry, tools };
}

describe.skipIf(!ENABLED)("MCP 生命周期（真实 stdio 握手）", () => {
  it("连接后注册工具且可真实调用；停用后工具被注销；再启用恢复", async () => {
    const rows = [fixtureRow()];
    const store = inMemoryStore(rows);
    const { registry, tools } = trackingRegistry();
    const service = createMcpService({
      env: { version: "test" } as ServerEnv,
      registry,
      store,
    });

    try {
      await service.connectAll();
      const [connected] = await service.listStatuses();
      expect(connected).toMatchObject({
        name: "fixture",
        status: "connected",
        toolCount: 1,
      });
      expect([...tools.keys()]).toEqual(["mcp__fixture__add_numbers"]);

      // 真实调用：走 MCP 协议回值
      const result = await tools
        .get("mcp__fixture__add_numbers")
        ?.execute({ a: 20, b: 22 }, {});
      const text = typeof result === "string" ? result : JSON.stringify(result);
      expect(text).toContain("42");

      // 停用：工具必须从注册表消失（不是只改状态）
      await service.setEnabled("fixture-1", false);
      expect(tools.size).toBe(0);
      const [disabled] = await service.listStatuses();
      expect(disabled).toMatchObject({ status: "disabled", toolCount: 0 });

      // 重新启用：恢复连接与工具
      await service.setEnabled("fixture-1", true);
      expect([...tools.keys()]).toEqual(["mcp__fixture__add_numbers"]);
      expect((await service.listStatuses())[0]).toMatchObject({
        status: "connected",
        toolCount: 1,
      });

      // 删除：断开并移除配置
      await service.remove("fixture-1");
      expect(tools.size).toBe(0);
      expect(await service.listStatuses()).toEqual([]);
    } finally {
      await service.shutdown();
    }
  }, 30_000);

  it("reconnect 会重建连接（工具不重复、不残留）", async () => {
    const rows = [fixtureRow()];
    const store = inMemoryStore(rows);
    const { registry, tools } = trackingRegistry();
    const service = createMcpService({
      env: { version: "test" } as ServerEnv,
      registry,
      store,
    });

    try {
      await service.connectAll();
      expect(tools.size).toBe(1);

      const status = await service.reconnect("fixture-1");
      expect(status).toMatchObject({ status: "connected", toolCount: 1 });
      expect(tools.size).toBe(1);
    } finally {
      await service.shutdown();
    }
  }, 30_000);
});

async function remoteFixture(protocol: "http" | "sse") {
  const mcp = new Server(
    { name: "remote-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "add_numbers",
        description: "fixture addition",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: "text",
        text: String(
          Number(request.params.arguments?.a) +
            Number(request.params.arguments?.b),
        ),
      },
    ],
  }));
  const streamable =
    protocol === "http"
      ? new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
      : null;
  let sse: SSEServerTransport | undefined;
  if (streamable)
    await mcp.connect(streamable as Parameters<Server["connect"]>[0]);
  async function body(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const http = createServer((request, response) => {
    void (async () => {
      if (streamable) {
        await streamable.handleRequest(
          request,
          response,
          request.method === "POST" ? await body(request) : undefined,
        );
      } else if (request.method === "GET" && request.url === "/mcp") {
        sse = new SSEServerTransport("/messages", response);
        await mcp.connect(sse);
      } else if (
        request.method === "POST" &&
        request.url?.startsWith("/messages") &&
        sse
      ) {
        await sse.handlePostMessage(request, response, await body(request));
      } else {
        response.writeHead(405).end();
      }
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("测试监听地址不可用");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await mcp.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe.skipIf(!ENABLED)("远程 MCP 实际协议", () => {
  it.each(["http", "sse"] as const)(
    "%s 握手、工具效果与停用注销",
    async (protocol) => {
      const remote = await remoteFixture(protocol);
      const rows = [
        fixtureRow({ kind: "http", command: "", args: [], url: remote.url }),
      ];
      const { registry, tools } = trackingRegistry();
      const service = createMcpService({
        env: { version: "test" } as ServerEnv,
        registry,
        store: inMemoryStore(rows),
      });
      try {
        await service.connectAll();
        expect(await service.listStatuses()).toEqual([
          expect.objectContaining({
            status: "connected",
            kind: "http",
            toolCount: 1,
          }),
        ]);
        const tool = tools.get("mcp__fixture__add_numbers");
        if (!tool) throw new Error("真实远程工具未注册");
        expect(
          JSON.stringify(await tool.execute({ a: 20, b: 22 }, {})),
        ).toContain("42");
        await service.setEnabled("fixture-1", false);
        expect(tools.size).toBe(0);
        expect(await service.listStatuses()).toEqual([
          expect.objectContaining({ status: "disabled", toolCount: 0 }),
        ]);
      } finally {
        await service.shutdown();
        await remote.close();
      }
    },
    30_000,
  );
});
