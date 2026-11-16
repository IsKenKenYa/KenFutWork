import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpIntegrationFixture } from "./mcp-integration.fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function tool(name: string, visibility?: unknown): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    ...(visibility === undefined ? {} : { _meta: { ui: { visibility } } }),
  };
}

const toolList = () => [
  tool("default_tool"),
  tool("model_tool", ["model"]),
  tool("both_tool", ["app", "model"]),
  tool("app_only", ["app"]),
  tool("nobody", []),
];

async function fixture() {
  return createMcpIntegrationFixture(toolList(), (close) =>
    cleanups.push(close),
  );
}

async function httpServer(tools: Tool[]) {
  const calls: string[] = [];
  const server = new Server(
    { name: "visibility", version: "1" },
    {
      capabilities: {
        tools: {},
        experimental: { "kenfutwork.computer-use": { version: 1 } },
      },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    return {
      content: [{ type: "text", text: `executed:${request.params.name}` }],
    };
  });
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
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await server.close();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("MCP测试服务地址不可用。");
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

describe.skipIf(process.env.KENFUTWORK_MCP_LIFECYCLE !== "1")(
  "MCP Apps 工具可见范围 integration",
  () => {
    it("HTTP实例工具目录排除界面专用工具，直接调用同样拒绝且没有远端副作用", async () => {
      const remote = await httpServer(toolList());
      const f = await fixture();
      await f.service.create({
        name: "visibility",
        kind: "http",
        url: remote.url,
        args: [],
        env: {},
        headers: {},
        enabled: true,
      });
      expect(
        f
          .resolved()
          .map(({ name }) => name)
          .sort(),
      ).toEqual([
        "mcp__visibility__both_tool",
        "mcp__visibility__default_tool",
        "mcp__visibility__model_tool",
      ]);
      const [connection] = await f.service.computerUseConnections();
      if (!connection) throw new Error("实际MCP连接没有登记。");
      for (const name of ["app_only", "nobody"])
        await expect(connection.call(name, {}, f.context)).rejects.toThrow(
          "未向模型开放",
        );
      expect(remote.calls).toEqual([]);
      for (const name of ["model_tool", "default_tool", "both_tool"])
        expect(await connection.call(name, {}, f.context)).toMatchObject({
          content: [{ type: "text", text: `executed:${name}` }],
        });
      expect(remote.calls).toEqual(["model_tool", "default_tool", "both_tool"]);
    });

    it("Task实际stdio目录及直接调用遵守相同范围，卸载后连接与目录均清除", async () => {
      const f = await fixture();
      const status = await f.tasks.install(
        { name: "visibility", command: "node", args: ["server.mjs"] },
        f.context,
      );
      expect(status.toolNames).toHaveLength(3);
      for (const name of ["app_only", "nobody"])
        expect(status.toolNames.some((value) => value.includes(name))).toBe(
          false,
        );
      const [connection] = await f.tasks.computerUseConnections(f.context);
      if (!connection) throw new Error("Task实际MCP连接没有登记。");
      for (const name of ["app_only", "nobody"])
        await expect(connection.call(name, {}, f.context)).rejects.toThrow(
          "未向模型开放",
        );
      await expect(
        readFile(join(f.root, "calls.jsonl"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await connection.call("model_tool", {}, f.context)).toMatchObject({
        content: [{ text: "executed:model_tool" }],
      });
      expect(await readFile(join(f.root, "calls.jsonl"), "utf8")).toBe(
        '{"name":"model_tool","arguments":{}}\n',
      );
      await f.tasks.remove("visibility", f.context);
      expect(f.resolved()).toEqual([]);
      expect(await f.tasks.computerUseConnections(f.context)).toEqual([]);
      await expect(
        connection.call("model_tool", {}, f.context),
      ).rejects.toThrow();
    });

    it.each(["model", ["unknown"], null])(
      "错误的可见范围 %j 明确报错且不留下部分工具",
      async (visibility) => {
        const remote = await httpServer([
          tool("default_tool"),
          tool("invalid_tool", visibility),
        ]);
        const f = await fixture();
        await f.service.create({
          name: "visibility",
          kind: "http",
          url: remote.url,
          args: [],
          env: {},
          headers: {},
          enabled: true,
        });
        expect(await f.service.listStatuses()).toMatchObject([
          { status: "error", error: expect.stringContaining("调用范围") },
        ]);
        expect(f.resolved()).toEqual([]);
        expect(remote.calls).toEqual([]);
      },
    );

    it("实例声明与Task实际服务的可见范围变化后拒绝旧工具调用", async () => {
      const f = await fixture();
      const metadata = tool("model_tool", ["model"]);
      await writeFile(
        join(f.root, "tools.json"),
        JSON.stringify([tool("model_tool", ["app"])]),
      );
      await expect(
        f.tasks.callConfigured(
          {
            name: "visibility",
            kind: "stdio",
            command: "node",
            args: ["server.mjs"],
            url: null,
            env: {},
            headers: {},
          },
          metadata,
          {},
          f.context,
        ),
      ).rejects.toThrow("不同工具定义");
      await expect(
        readFile(join(f.root, "calls.jsonl"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
