import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { ServerEnv } from "../../config/env.js";
import type { ToolDefinition, ToolRegistry } from "../../kernel/types.js";
import { createMcpService } from "./mcp-service.js";
import type { McpServerStore, StoredMcpServer } from "./server-store.js";

function fakeStore(rows: StoredMcpServer[]): McpServerStore {
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
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
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

function fakeRegistry() {
  const registered = new Map<string, ToolDefinition>();
  const registry = {
    register(definition: ToolDefinition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
    get: (name: string) => registered.get(name),
    list: () => [...registered.values()],
  } as unknown as ToolRegistry;
  return { registry, registered };
}

function stored(
  over: Partial<StoredMcpServer> & { name: string },
): StoredMcpServer {
  return {
    id: over.id ?? `id-${over.name}`,
    kind: over.kind ?? "stdio",
    command: over.command ?? "definitely-not-a-real-binary-xyz",
    url: over.url ?? null,
    args: over.args ?? [],
    env: over.env ?? {},
    headers: over.headers ?? {},
    enabled: over.enabled ?? false,
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    ...over,
  };
}

const EMPTY_ENV = { version: "test" } as ServerEnv;

/** 截获真实 HTTP 请求的桩（http 类型的请求头必须在本机线上验证，不看构造代码）。 */
let stub: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!stub) return resolve();
    stub.close(() => resolve());
    stub = undefined;
  });
});
async function startHttpStub(): Promise<{
  url: string;
  requests: Array<Record<string, string | string[] | undefined>>;
}> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((request, response) => {
    requests.push({ ...request.headers });
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unauthorized" }));
  });
  stub = server;
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, requests };
}

/**
 * MCP 运行态管理：配置来源合并（库内优先）+ 连接失败是运行态而非配置错误 +
 * 启停/删除后的工具收敛。真实连接用不存在的命令触发失败路径（不起进程）。
 */
describe("MCP 运行态管理", () => {
  it("来源合并：库内 managed 优先，环境变量补充未重名项且标为 env", async () => {
    const store = fakeStore([stored({ name: "shared", enabled: false })]);
    const { registry } = fakeRegistry();
    const service = createMcpService({
      env: {
        version: "test",
        mcpServers: [
          { name: "shared", command: "env-version" },
          { name: "env-only", command: "env-only-cmd" },
        ],
      } as ServerEnv,
      registry,
      store,
    });

    const statuses = await service.listStatuses();
    const shared = statuses.find((s) => s.name === "shared");
    const envOnly = statuses.find((s) => s.name === "env-only");

    // 同名：库内配置胜出（命令来自库内，来源 managed，尊重 enabled=false）
    expect(shared).toMatchObject({
      source: "managed",
      command: "definitely-not-a-real-binary-xyz",
      enabled: false,
      status: "disabled",
    });
    // 未重名：环境变量项只读存在
    expect(envOnly).toMatchObject({ source: "env", enabled: true });
    expect(envOnly?.id).toBeNull();
  });

  it("停用项不连接：状态 disabled、工具数为 0，且不注册任何工具", async () => {
    const store = fakeStore([stored({ name: "off", enabled: false })]);
    const { registry, registered } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    await service.connectAll();
    const statuses = await service.listStatuses();

    expect(statuses[0]).toMatchObject({ status: "disabled", toolCount: 0 });
    expect(registered.size).toBe(0);
  });

  it("连接失败是运行态：status=error + 原因可查，不抛错、不注册工具", async () => {
    const store = fakeStore([stored({ name: "broken", enabled: true })]);
    const { registry, registered } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    await expect(service.connectAll()).resolves.toBeUndefined();
    const [status] = await service.listStatuses();

    expect(status?.status).toBe("error");
    expect(status?.error).toBeTruthy();
    expect(registered.size).toBe(0);
  });

  it("env 值不外发：状态只给键名", async () => {
    const store = fakeStore([
      stored({
        name: "with-secret",
        enabled: false,
        env: { API_KEY: "sk-super-secret" },
      }),
    ]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    const [status] = await service.listStatuses();
    expect(status?.envKeys).toEqual(["API_KEY"]);
    expect(JSON.stringify(status)).not.toContain("sk-super-secret");
  });

  it("create 返回公开形态（无 env 值）+ 删除后不再出现在状态里", async () => {
    const store = fakeStore([]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    const created = await service.create({
      name: "new-server",
      command: "definitely-not-a-real-binary-xyz",
      args: ["--flag"],
      url: null,
      env: { TOKEN: "secret-value" },
      enabled: false,
    });
    expect(created.envKeys).toEqual(["TOKEN"]);
    expect(created.headerKeys).toEqual([]);
    expect(JSON.stringify(created)).not.toContain("secret-value");

    expect((await service.listStatuses()).map((s) => s.name)).toEqual([
      "new-server",
    ]);
    expect(await service.remove(created.id)).toBe(1);
    expect(await service.listStatuses()).toEqual([]);
  });

  it("http 类型：归一化入列（command 空串、url 承载端点），状态带 kind/url", async () => {
    const store = fakeStore([]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    const created = await service.create({
      name: "remote",
      kind: "http",
      url: "https://127.0.0.1:9/unreachable/mcp",
      args: [],
      env: {},
      enabled: false, // 不触发真实连接，只验归一化与落库形态
    });
    expect(created).toMatchObject({
      kind: "http",
      command: "",
      url: "https://127.0.0.1:9/unreachable/mcp",
    });

    // stdio 缺省 kind：url 归一化为 null
    const stdio = await service.create({
      name: "local",
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      env: {},
      enabled: false,
    });
    expect(stdio).toMatchObject({ kind: "stdio", url: null });

    const [remoteStatus, localStatus] = await service.listStatuses();
    expect(remoteStatus).toMatchObject({ kind: "http", status: "disabled" });
    expect(localStatus).toMatchObject({ kind: "stdio", status: "disabled" });
  });

  it("http 类型启用后连不上是运行态 error（不抛错、不注册工具）", async () => {
    const store = fakeStore([]);
    const { registry, registered } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    await service.create({
      name: "remote-dead",
      kind: "http",
      // 保留地址端口立即 ECONNREFUSED，不等待超时
      url: "https://127.0.0.1:9/mcp",
      args: [],
      env: {},
      enabled: true,
    });
    const [status] = await service.listStatuses();
    expect(status).toMatchObject({
      kind: "http",
      status: "error",
      toolCount: 0,
    });
    expect(status?.error).toBeTruthy();
    expect(registered.size).toBe(0);
  });

  it("http 类型的自定义请求头真的发到线上（HA 的 Authorization 靠这条）", async () => {
    const httpStub = await startHttpStub();
    const store = fakeStore([]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    await service.create({
      name: "ha-mcp",
      kind: "http",
      url: httpStub.url,
      args: [],
      env: {},
      headers: { Authorization: "Bearer ha-token", "X-Api-Key": "k-1" },
      enabled: true,
    });

    // 桩回 401：连接失败是运行态，但两次尝试（Streamable HTTP + SSE 回退）都必须带自定义头
    expect(httpStub.requests.length).toBeGreaterThan(0);
    for (const headers of httpStub.requests) {
      expect(headers.authorization).toBe("Bearer ha-token");
      expect(headers["x-api-key"]).toBe("k-1");
    }

    // 值不外发：状态与响应只回键名
    const [status] = await service.listStatuses();
    expect(status?.status).toBe("error");
    expect([...(status?.headerKeys ?? [])].sort()).toEqual([
      "Authorization",
      "X-Api-Key",
    ]);
    expect(JSON.stringify(status)).not.toContain("ha-token");

    const updated = await service.update("id-ha-mcp", {
      headers: { Authorization: "Bearer rotated" },
    });
    expect(updated?.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(updated)).not.toContain("rotated");
    // 改头后重连：新令牌同样发到线上
    await service.reconnect("id-ha-mcp");
    expect(httpStub.requests.at(-1)?.authorization).toBe("Bearer rotated");
  });

  it("stdio 类型不吃请求头：归一化为空对象（库里不留用不上的密钥）", async () => {
    const store = fakeStore([]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    const created = await service.create({
      name: "local-with-headers",
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      env: {},
      headers: { Authorization: "Bearer should-not-persist" },
      enabled: false,
    });

    expect(created.headerKeys).toEqual([]);
    expect(JSON.stringify(created)).not.toContain("should-not-persist");
    expect((await store.list())[0]?.headers).toEqual({});
  });

  it("setEnabled 生效并回流公开形态；重连不存在的 id 返回 null", async () => {
    const store = fakeStore([stored({ name: "toggle", enabled: false })]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    const enabled = await service.setEnabled("id-toggle", true);
    expect(enabled?.enabled).toBe(true);
    // 命令不存在 → 连接失败，但配置变更本身成功
    expect((await service.listStatuses())[0]?.status).toBe("error");

    expect(await service.reconnect("no-such-id")).toBeNull();
  });

  it("shutdown 幂等且不抛错（无连接时）", async () => {
    const store = fakeStore([]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });
    await expect(service.shutdown()).resolves.toBeUndefined();
    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});

describe("启动连接的健壮性（曾被 unhandled rejection 带走进程）", () => {
  it("读库失败（表缺失/数据库不可用）不抛错：跳过连接，端点仍可用", async () => {
    const store = fakeStore([]);
    store.list = async () => {
      throw new Error('relation "public.mcp_servers" does not exist');
    };
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    // 启动期 fire-and-forget 的调用方（void connectAll()）不应因它崩进程
    await expect(service.connectAll()).resolves.toBeUndefined();
    // 状态查询同样退化而不抛（界面可重连）
    await expect(service.listStatuses()).rejects.toThrow(/does not exist/);
  });

  it("单个 server 连接抛错不影响其它 server 的连接尝试", async () => {
    const store = fakeStore([
      stored({ name: "broken", enabled: true }),
      stored({ name: "off", enabled: false }),
    ]);
    const { registry } = fakeRegistry();
    const service = createMcpService({ env: EMPTY_ENV, registry, store });

    await expect(service.connectAll()).resolves.toBeUndefined();
    const statuses = await service.listStatuses();
    expect(statuses.map((s) => s.name).sort()).toEqual(["broken", "off"]);
    expect(statuses.find((s) => s.name === "broken")?.status).toBe("error");
    expect(statuses.find((s) => s.name === "off")?.status).toBe("disabled");
  });
});
