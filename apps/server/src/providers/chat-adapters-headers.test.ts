import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createInstanceChatModel as createAnthropicModel } from "./anthropic/index.js";
import { createInstanceChatModel as createGeminiModel } from "./gemini/index.js";

/**
 * anthropic / gemini 的自定义头上线验证（§4.8「一视同仁」）。
 *
 * 手法：桩服务一律回 400（SDK 对 400 不重试）并记录收到的头——我们只关心
 * 「头有没有真的发出去」，不关心各自线协议的响应格式，故不铺完整 SSE 桩。
 */

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

async function startRejectingStub(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, string | string[] | undefined>>;
}> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
  server = createServer((req, res) => {
    requests.push({ ...req.headers });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub" } }));
  });
  const stub = server;
  await new Promise<void>((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = stub.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe("anthropic 适配器：自定义头上线（§4.8）", () => {
  it("自定义头随请求发出，凭证头 x-api-key 仍由 apiKey 生成", async () => {
    const stub = await startRejectingStub();
    const model = createAnthropicModel("claude-test", {
      apiKey: "sk-ant-instance",
      baseUrl: stub.baseUrl,
      headers: { "x-tenant-id": "ws-42" },
    });

    await model.invoke("你好").catch(() => undefined);

    expect(stub.requests.length).toBeGreaterThan(0);
    const headers = stub.requests[0] ?? {};
    expect(headers["x-tenant-id"]).toBe("ws-42");
    expect(headers["x-api-key"]).toBe("sk-ant-instance");
  });
});

describe("gemini 适配器：自定义头上线（§4.8）", () => {
  it("自定义头随请求发出，凭证头 x-goog-api-key 仍由 apiKey 生成", async () => {
    const stub = await startRejectingStub();
    const model = createGeminiModel("gemini-test", {
      apiKey: "goog-instance-key",
      baseUrl: stub.baseUrl,
      headers: { "x-tenant-id": "ws-42" },
    });

    await model.invoke("你好").catch(() => undefined);

    expect(stub.requests.length).toBeGreaterThan(0);
    const headers = stub.requests[0] ?? {};
    expect(headers["x-tenant-id"]).toBe("ws-42");
    expect(headers["x-goog-api-key"]).toBe("goog-instance-key");
  });
});
