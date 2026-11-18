import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type EventStore,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { adaptSdkTransport } from "./sdk-transport.js";

const require = createRequire(import.meta.url);
const cjsServer: typeof import("@modelcontextprotocol/sdk/server/index.js") =
  require("@modelcontextprotocol/sdk/server/index.js");
const cjsTransport: typeof import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js") =
  require("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
const forms = [
  {
    format: "ESM",
    Server,
    Transport: WebStandardStreamableHTTPServerTransport,
  },
  {
    format: "CJS",
    Server: cjsServer.Server,
    Transport: cjsTransport.WebStandardStreamableHTTPServerTransport,
  },
].flatMap((api) => [false, true].map((resumable) => ({ ...api, resumable })));

it.each(forms)(
  "$format eventStore=$resumable的取消关闭body并保留正确关联生命周期",
  async ({ Transport, Server: SdkServer, resumable }) => {
    const eventStore: EventStore = {
      storeEvent: async (streamId) => streamId,
      replayEventsAfter: async (eventId) => eventId,
    };
    const transport = new Transport({
      sessionIdGenerator: () => "sdk-cancel-test",
      keepAliveMs: 0,
      ...(resumable ? { eventStore } : {}),
    });
    const server = new SdkServer(
      { name: "sdk-cleanup-test", version: "test" },
      { capabilities: { tools: {} } },
    );
    let started = 0;
    let cancelled = 0;
    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => {
      started++;
      await new Promise<void>((resolve) => {
        extra.signal.addEventListener("abort", () => resolve(), { once: true });
        if (extra.signal.aborted) resolve();
      });
      cancelled++;
      return { content: [] };
    });
    const post = (message: unknown, initialized = true) =>
      transport.handleRequest(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(initialized
              ? {
                  "mcp-session-id": "sdk-cancel-test",
                  "mcp-protocol-version": "2025-11-25",
                }
              : {}),
          },
          body: JSON.stringify(message),
        }),
      );
    try {
      await server.connect(adaptSdkTransport(transport));
      const init = await post(
        {
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "cleanup-consumer", version: "test" },
          },
        },
        false,
      );
      expect(init.status).toBe(200);
      await init.text();
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      for (const id of ["cancel-a", "cancel-b", "cancel-c"]) {
        const response = await post({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "wait", arguments: {} },
        });
        await expect.poll(() => started).toBe(cancelled + 1);
        const notice = await post({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id },
        });
        expect(notice.status).toBe(202);
        transport.closeSSEStream(id);
        const body = await response.text();
        if (!resumable) expect(body).toBe("");
        await expect.poll(() => cancelled).toBe(started);
        // 仅此SDK补丁回归检查上游资源持有；业务消费者不读取或修改私有映射。
        const correlations = Reflect.get(transport, "_requestToStreamMapping");
        expect(correlations).toBeInstanceOf(Map);
        expect(correlations.size).toBe(resumable ? started : 0);
      }
      expect(cancelled).toBe(3);
    } finally {
      await server.close();
    }
    expect(Reflect.get(transport, "_requestToStreamMapping").size).toBe(0);
  },
);
