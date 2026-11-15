import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { createInstanceChatModel as createAnthropicModel } from "./anthropic/index.js";
import { createInstanceChatModel as createGeminiModel } from "./gemini/index.js";
import { createInstanceChatModel as createOpenAIModel } from "./openai-compatible/index.js";

async function pendingProvider() {
  const requests: Array<{
    response: ServerResponse;
    closed: boolean;
    body: Record<string, unknown>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry = {
      response,
      closed: false,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    requests.push(entry);
    response.once("close", () => {
      entry.closed = true;
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

it.each(
  (
    [
      ["OpenAI", createOpenAIModel],
      ["Anthropic", createAnthropicModel],
      ["Gemini", createGeminiModel],
    ] as const
  ).flatMap(([name, createModel]) =>
    [false, true].map((streaming) => ({ name, createModel, streaming })),
  ),
)(
  "$name streaming=$streaming 取消关闭实际 HTTP 请求",
  async ({ createModel, streaming }) => {
    const provider = await pendingProvider();
    const controller = new AbortController();
    let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const model = createModel("cancellation-model", {
        apiKey: "local-test-key",
        baseUrl: provider.baseUrl,
        invocationStreaming: streaming,
        invocationMaxRetries: 0,
      });
      outcome = Promise.allSettled([
        model.invoke("等待取消", { signal: controller.signal }),
      ]);
      await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
      controller.abort(new DOMException("停止当前模型请求", "AbortError"));
      await vi.waitFor(() => expect(provider.requests[0]?.closed).toBe(true));
      expect(await outcome).toMatchObject([{ status: "rejected" }]);
      expect(provider.requests).toHaveLength(1);
    } finally {
      controller.abort();
      await provider.close();
      await outcome;
    }
  },
);

it("Gemini 开始前已取消时不发送 HTTP 请求", async () => {
  const provider = await pendingProvider();
  const controller = new AbortController();
  controller.abort(new DOMException("请求已取消", "AbortError"));
  try {
    const model = createGeminiModel("cancelled-model", {
      apiKey: "local-test-key",
      baseUrl: provider.baseUrl,
      invocationStreaming: false,
      invocationMaxRetries: 0,
    });
    await expect(
      model.invoke("不应发送", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
  } finally {
    await provider.close();
  }
});

it.each([true, false])(
  "同一 Gemini 模型并发时只取消指定请求，第二个信号 %s",
  async (withSecondSignal) => {
    const provider = await pendingProvider();
    const first = new AbortController();
    const second = new AbortController();
    let outcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const model = createGeminiModel("concurrent-model", {
        apiKey: "local-test-key",
        baseUrl: provider.baseUrl,
        invocationStreaming: false,
        invocationMaxRetries: 0,
      });
      outcome = Promise.allSettled([
        model.invoke("请求一", { signal: first.signal }),
        model.invoke(
          "请求二",
          withSecondSignal ? { signal: second.signal } : undefined,
        ),
      ]);
      await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
      const [one, two] = ["请求一", "请求二"].map((text) =>
        provider.requests.find((request) =>
          JSON.stringify(request.body).includes(text),
        ),
      );
      if (!one || !two) throw new Error("并发模型请求未到达供应商");
      first.abort(new DOMException("仅停止请求一", "AbortError"));
      await vi.waitFor(() => expect(one.closed).toBe(true));
      expect(two.closed).toBe(false);
      expect(second.signal.aborted).toBe(false);
      two.response.writeHead(200, { "content-type": "application/json" });
      two.response.end(
        JSON.stringify({
          candidates: [
            {
              index: 0,
              content: { role: "model", parts: [{ text: "独立请求完成" }] },
              finishReason: "STOP",
            },
          ],
        }),
      );
      expect(await outcome).toMatchObject([
        { status: "rejected" },
        { status: "fulfilled", value: { content: "独立请求完成" } },
      ]);
      expect(provider.requests).toHaveLength(2);
    } finally {
      first.abort();
      second.abort();
      await provider.close();
      await outcome;
    }
  },
);
