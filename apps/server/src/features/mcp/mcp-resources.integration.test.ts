import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpIntegrationFixture } from "./mcp-integration.fixture.js";
import { deferred } from "./test-stdio-process.js";

const runIntegration = process.env.KENFUTWORK_MCP_LIFECYCLE === "1";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const cursor = "页+/=😀";

async function taskFixture() {
  const f = await createMcpIntegrationFixture([], (close) =>
    cleanups.push(close),
  );
  await writeFile(join(f.root, "notes.txt"), "真实 MCP 资源 😀\n", "utf8");
  return f;
}

async function fixture() {
  const f = await taskFixture();
  const requests: string[] = [];
  const reading = deferred<void>();
  const cancelled = deferred<void>();
  const server = new Server(
    { name: "resources-only", version: "1" },
    { capabilities: { resources: {} } },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async ({ params }) => {
    requests.push(`list:${params?.cursor ?? "first"}`);
    const _meta = { privateContent: "private-list" };
    return params?.cursor === cursor
      ? { resources: [{ uri: "demo://binary", name: "binary", _meta }] }
      : {
          resources: [
            {
              uri: "demo://notes",
              name: "notes",
              mimeType: "text/plain",
              _meta,
            },
            { uri: "ui://plugin/view", name: "private-view" },
          ],
          nextCursor: cursor,
        };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "demo://{name}",
        name: "named-resource",
        _meta: { privateContent: "private-template" },
      },
      { uriTemplate: "ui://plugin/{name}", name: "private-view" },
    ],
  }));
  server.setRequestHandler(
    ReadResourceRequestSchema,
    async ({ params }, { signal }) => {
      requests.push(`read:${params.uri}`);
      if (params.uri === "demo://slow") {
        signal.addEventListener("abort", () => cancelled.resolve(), {
          once: true,
        });
        reading.resolve();
        await cancelled.promise;
        signal.throwIfAborted();
      }
      if (params.uri === "demo://binary") {
        return { contents: [{ uri: params.uri, blob: "AAEC" }] };
      }
      return {
        contents: [
          {
            uri: params.uri,
            mimeType: "text/plain",
            text: await readFile(join(f.root, "notes.txt"), "utf8"),
            _meta: { privateContent: "private-document" },
            privateContent: "private-extra",
          },
          { uri: "ui://plugin/view", text: "<div>private view</div>" },
        ],
        _meta: { privateContent: "private-response" },
      };
    },
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
  });
  await server.connect(transport as Parameters<Server["connect"]>[0]);
  const http = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      if (request.method === "POST")
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
      await transport.handleRequest(
        request,
        response,
        request.method === "POST"
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : undefined,
      );
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.unshift(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("资源服务地址不可用。");
  const installed = await f.service.create({
    name: "resources",
    kind: "http",
    url: `http://127.0.0.1:${address.port}/mcp`,
    args: [],
    env: {},
    headers: {},
    enabled: true,
  });
  const execute = (
    operation: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) => {
    const tool = f
      .resolved()
      .find(({ name }) => name.endsWith(`__${operation}`));
    if (!tool) throw new Error(`MCP ${operation} 资源工具没有接通。`);
    return f.registry.executeDefinition(tool, args, {
      ...f.context,
      toolCallId: randomUUID(),
      ...(signal ? { signal } : {}),
    });
  };
  return { ...f, installed, execute, requests, reading, cancelled };
}

describe.skipIf(!runIntegration)("MCP 资源读取 integration", () => {
  it("仅声明资源的服务可连接，资源分页、模板与读取进入现有工具审批入口", async () => {
    const f = await fixture();
    expect(await f.service.listStatuses()).toMatchObject([
      { status: "connected" },
    ]);
    expect(await f.execute("list")).toEqual({
      resources: [
        { uri: "demo://notes", name: "notes", mimeType: "text/plain" },
      ],
      nextCursor: cursor,
    });
    expect(await f.execute("list", { cursor })).toEqual({
      resources: [{ uri: "demo://binary", name: "binary" }],
    });
    expect(await f.execute("templates")).toEqual({
      resourceTemplates: [
        { uriTemplate: "demo://{name}", name: "named-resource" },
      ],
    });
    expect(await f.execute("read", { uri: "demo://notes" })).toEqual({
      contents: [
        {
          uri: "demo://notes",
          mimeType: "text/plain",
          text: "真实 MCP 资源 😀\n",
        },
      ],
    });
    expect(await f.execute("read", { uri: "demo://binary" })).toEqual({
      contents: [{ uri: "demo://binary", blob: "AAEC" }],
    });
    await expect(f.execute("read", { uri: "" })).rejects.toThrow();
    await expect(
      f.execute("read", { uri: "UI://plugin/view" }),
    ).rejects.toThrow("只供插件页面使用");
    expect(f.requests).toEqual([
      "list:first",
      `list:${cursor}`,
      "read:demo://notes",
      "read:demo://binary",
    ]);
  });

  it("只读角色和停用后的旧资源工具均拒绝，不能产生实际读取", async () => {
    const f = await fixture();
    expect(
      f.registry.resolveRunTools({
        ...f.resolution(),
        scopeHandle: f.handle.derive("review", "reader"),
      }),
    ).toEqual([]);
    const tool = f.resolved().find(({ name }) => name.endsWith("__read"));
    if (!tool) throw new Error("资源读取工具没有接通。");
    await f.service.setEnabled(f.installed.id, false);
    await expect(
      f.registry.executeDefinition(tool, { uri: "demo://notes" }, f.context),
    ).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });

  it("取消读取通知实际 HTTP 服务并保留取消原因", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const reason = new DOMException("本次读取已取消", "AbortError");
    const result = f.execute("read", { uri: "demo://slow" }, abort.signal);
    const rejected = expect(result).rejects.toBe(reason);
    await Promise.race([f.reading.promise, result]);
    abort.abort(reason);
    await rejected;
    await f.cancelled.promise;
  });

  it("Task 与实例配置的 stdio 均在 Task 目录读取，停用及卸载后拒绝旧工具", async () => {
    const f = await taskFixture();
    const local = await f.tasks.install(
      {
        name: "local",
        command: "node",
        args: ["server.mjs", "--resources-only"],
      },
      f.context,
    );
    const configured = await f.service.create({
      name: "configured",
      kind: "stdio",
      command: "node",
      args: [join(f.root, "server.mjs"), "--resources-only"],
      env: {},
      headers: {},
      enabled: true,
    });
    const available = f
      .resolved()
      .filter(({ name }) => name.endsWith("__read"));
    const localRead = available.find(({ name }) =>
      local.toolNames.includes(name),
    );
    const configuredRead = available.find(
      ({ name }) => !local.toolNames.includes(name),
    );
    if (!localRead || !configuredRead) throw new Error("stdio 资源未登记。");
    const request = { uri: "demo://notes" };
    for (const tool of [localRead, configuredRead]) {
      expect(
        await f.registry.executeDefinition(tool, request, {
          ...f.context,
          toolCallId: randomUUID(),
        }),
      ).toEqual({ contents: [{ ...request, text: "真实 MCP 资源 😀\n" }] });
    }
    await f.tasks.remove("local", f.context);
    await f.service.setEnabled(configured.id, false);
    expect(f.resolved()).toEqual([]);
    for (const tool of [localRead, configuredRead]) {
      await expect(
        f.registry.executeDefinition(tool, request, {
          ...f.context,
          toolCallId: randomUUID(),
        }),
      ).rejects.toThrow();
    }
  });
});
