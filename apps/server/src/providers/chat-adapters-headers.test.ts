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
  bodies: Array<Record<string, unknown>>;
}> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
  const bodies: Array<Record<string, unknown>> = [];
  server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    bodies.push(JSON.parse(body));
    requests.push({ ...req.headers });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "stub" } }));
  });
  const stub = server;
  await new Promise<void>((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = stub.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, bodies };
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

it("Anthropic原生调用实际消费本轮冻结的输出和思考参数，保留SDK输入", async () => {
  const stub = await startRejectingStub();
  const model = createAnthropicModel(
    "claude-test",
    {
      apiKey: "fixture",
      baseUrl: stub.baseUrl,
      invocationStreaming: false,
      invocationMaxRetries: 0,
    },
    {
      max_tokens: 321,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
    },
  );
  await model.invoke("原始输入").catch(() => undefined);
  expect(stub.bodies).toHaveLength(1);
  expect(stub.bodies[0]).toMatchObject({
    model: "claude-test",
    max_tokens: 321,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "原始输入" }],
  });
});

it("Gemini原生调用实际消费本轮generationConfig，保留SDK输入和工具参数", async () => {
  const stub = await startRejectingStub();
  const model = createGeminiModel(
    "gemini-test",
    {
      apiKey: "fixture",
      baseUrl: stub.baseUrl,
      invocationStreaming: false,
      invocationMaxRetries: 0,
    },
    {
      generationConfig: {
        maxOutputTokens: 321,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  );
  await model.invoke("原始输入").catch(() => undefined);
  expect(stub.bodies).toHaveLength(1);
  expect(stub.bodies[0]).toMatchObject({
    generationConfig: {
      maxOutputTokens: 321,
      thinkingConfig: { thinkingBudget: 0 },
    },
    contents: [{ role: "user", parts: [{ text: "原始输入" }] }],
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
