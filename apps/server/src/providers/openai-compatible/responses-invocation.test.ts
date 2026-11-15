import { createServer } from "node:http";
import { AIMessage } from "@langchain/core/messages";
import { expect, it } from "vitest";
import { createInstanceChatModel } from "./index.js";

const result = {
  id: "resp-invocation",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "responses-model",
  output: [
    {
      id: "msg-invocation",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "协议完成", annotations: [] }],
    },
  ],
  output_text: "协议完成",
  usage: {
    input_tokens: 31,
    output_tokens: 4,
    total_tokens: 35,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 2 },
  },
};

async function responsesFixture(streaming: boolean) {
  const requests: {
    path: string | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (!streaming) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      {
        type: "response.created",
        response: { ...result, status: "in_progress", output: [], usage: null },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-invocation",
        output_index: 0,
        content_index: 0,
        delta: "协议完成",
      },
      { type: "response.completed", response: result },
    ];
    for (const [sequence, event] of events.entries()) {
      response.write(
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`,
      );
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("协议服务未就绪");
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

it.each([true, false])(
  "Responses 直接调用保留内容、原生身份与真实用量，流式=%s",
  async (streaming) => {
    const f = await responsesFixture(streaming);
    try {
      const model = createInstanceChatModel("responses-model", {
        apiKey: "fixture-key",
        baseUrl: f.baseUrl,
        useResponsesApi: true,
        invocationStreaming: streaming,
        invocationMaxRetries: 0,
      });
      const message = await model.invoke("检查 Responses");
      if (!AIMessage.isInstance(message))
        throw new Error("模型没有返回助手消息");
      expect(message.text).toBe("协议完成");
      expect(message.id).toBe("resp-invocation");
      expect(message.usage_metadata).toMatchObject({
        input_tokens: 31,
        output_tokens: 4,
        total_tokens: 35,
        input_token_details: { cache_read: 10 },
        output_token_details: { reasoning: 2 },
      });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]).toMatchObject({
        path: "/v1/responses",
        body: { stream: streaming },
      });
    } finally {
      await f.close();
    }
  },
);
