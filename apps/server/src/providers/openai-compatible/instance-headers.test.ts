import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createInstanceChatModel } from "./index.js";

/**
 * 自定义请求头**发到线上**的端到端验证（§4.8 验收用例）：
 * 起一个本地 OpenAI 兼容桩服务，截获真实请求头。
 * 这是「接线是否真的生效」的证据——只断言构造参数会漏掉 SDK 吞掉配置的情况。
 */

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server = undefined;
  });
});

/** 桩服务：记录每次请求的头，按 SSE 回一个最小可用的 chat completion。 */
async function startStub(): Promise<{
  baseUrl: string;
  requests: Array<Record<string, string | string[] | undefined>>;
}> {
  const requests: Array<Record<string, string | string[] | undefined>> = [];
  server = createServer((req, res) => {
    requests.push({ ...req.headers });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
  const stub = server;

  await new Promise<void>((resolve) => {
    stub.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = stub.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

describe("openai-compatible 适配器：自定义头上线（§4.8）", () => {
  it("自定义头随请求发出，凭证头仍由 apiKey 生成（未被顶掉）", async () => {
    const stub = await startStub();
    const model = createInstanceChatModel("test-model", {
      apiKey: "sk-instance-key",
      baseUrl: stub.baseUrl,
      headers: {
        "x-opencode-session": "sess-abc",
        "x-tenant-id": "ws-42",
      },
    });

    await model.invoke("你好");

    expect(stub.requests).toHaveLength(1);
    const headers = stub.requests[0] ?? {};
    expect(headers["x-opencode-session"]).toBe("sess-abc");
    expect(headers["x-tenant-id"]).toBe("ws-42");
    // 保留头：Authorization 必须是 apiKey 生成的，自定义头碰不到它
    expect(headers.authorization).toBe("Bearer sk-instance-key");
  });

  it("同一实例两次调用可拿到不同会话值（亲和按会话，不按实例）", async () => {
    const first = await startStub();
    await createInstanceChatModel("m", {
      apiKey: "sk-1",
      baseUrl: first.baseUrl,
      headers: { "x-opencode-session": "sess-a" },
    }).invoke("hi");
    expect(first.requests[0]?.["x-opencode-session"]).toBe("sess-a");

    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server = undefined;
    });
    const second = await startStub();
    await createInstanceChatModel("m", {
      apiKey: "sk-1",
      baseUrl: second.baseUrl,
      headers: { "x-opencode-session": "sess-b" },
    }).invoke("hi");
    expect(second.requests[0]?.["x-opencode-session"]).toBe("sess-b");
  });

  it("未配置自定义头的实例：请求照常发出，不多带任何自定义头", async () => {
    const stub = await startStub();
    const model = createInstanceChatModel("test-model", {
      apiKey: "sk-instance-key",
      baseUrl: stub.baseUrl,
    });

    await model.invoke("你好");

    const headers = stub.requests[0] ?? {};
    expect(headers.authorization).toBe("Bearer sk-instance-key");
    expect(headers["x-opencode-session"]).toBeUndefined();
    expect(headers["x-tenant-id"]).toBeUndefined();
  });
});
