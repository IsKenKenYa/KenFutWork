import { createServer, type Server } from "node:http";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, expect, it } from "vitest";
import { resolveInstanceChatModel } from "../resolve.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function rejectingEndpoints() {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(request.url === "/v1/responses" ? 404 : 400, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        error: {
          message:
            request.url === "/v1/responses"
              ? "Unknown request URL: /v1/responses"
              : "invalid test request",
        },
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP协议夹具未分配TCP端口。");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, paths };
}

async function recordingCompletions() {
  const requests: Array<{
    messages: Array<{
      role: string;
      content: unknown;
      tool_call_id?: string;
      name?: string;
    }>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const reply = {
      id: "recorded",
      object: "chat.completion",
      created: 1,
      model: "test",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
    };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ ...reply, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("文字工具HTTP夹具未就绪");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

it.each([false, true])(
  "Completions文字块归一兼容空结果和流式=%s，保留图片、调用身份与原消息",
  async (streaming) => {
    const endpoint = await recordingCompletions();
    const contents = [
      [],
      [{ type: "text", text: "" }],
      [
        { type: "text", text: " a \n" },
        { type: "text", text: "" },
        { type: "text", text: "β" },
      ],
      "unchanged",
      [
        { type: "text", text: "caption" },
        {
          type: "image_url",
          image_url: { url: "https://example.invalid/fixture.png" },
        },
      ],
    ];
    const tools = contents.map(
      (content, index) =>
        new ToolMessage({
          content,
          tool_call_id: `call-${index}`,
          id: `message-${index}`,
          name: `tool_${index}`,
          artifact: { marker: index },
          additional_kwargs: { marker: index },
          response_metadata: { marker: index },
          status: "success",
        }),
    );
    const original = tools.map((message) => ({
      content: message.content,
      artifact: message.artifact,
      json: JSON.stringify(message),
    }));
    const messages = [
      new HumanMessage({
        content: [{ type: "text", text: "user stays array" }],
      }),
      new AIMessage({
        content: "",
        tool_calls: tools.map((message) => ({
          id: message.tool_call_id,
          name: message.name ?? "tool",
          args: {},
        })),
      }),
      ...tools,
    ];
    const model = resolveInstanceChatModel("openai-compatible", "test", {
      apiKey: "fixture",
      baseUrl: endpoint.baseUrl,
      useResponsesApi: false,
      invocationStreaming: streaming,
      invocationMaxRetries: 0,
    });
    if (streaming)
      for await (const _chunk of await model.stream(messages)) {
        /* 消费真实流式入口 */
      }
    else await model.invoke(messages);
    expect(endpoint.requests).toHaveLength(1);
    const request = endpoint.requests[0];
    expect(request?.messages[0]?.content).toEqual([
      { type: "text", text: "user stays array" },
    ]);
    const outputs = request?.messages.filter(
      (message) => message.role === "tool",
    );
    expect(outputs?.map((message) => message.tool_call_id)).toEqual(
      tools.map((message) => message.tool_call_id),
    );
    expect(outputs?.map((message) => message.content)).toEqual([
      "",
      "",
      " a \n\n\nβ",
      "unchanged",
      contents[4],
    ]);
    for (const [index, message] of tools.entries()) {
      expect(message.content).toBe(original[index]?.content);
      expect(message.artifact).toBe(original[index]?.artifact);
      expect(JSON.stringify(message)).toBe(original[index]?.json);
    }
  },
);

it("显式completions不被probe或SDK模型名启发式改走responses", async () => {
  const stub = await rejectingEndpoints();
  const model = resolveInstanceChatModel("openai-compatible", "gpt-5-pro", {
    apiKey: "dialect-test-key",
    baseUrl: stub.baseUrl,
    useResponsesApi: false,
    responsesApi: true,
  });
  await expect(model.invoke("hello")).rejects.toThrow();
  expect(stub.paths).toEqual(["/v1/chat/completions"]);
});

it("显式responses发原生responses，404也不静默回落其它dialect", async () => {
  const stub = await rejectingEndpoints();
  const model = resolveInstanceChatModel("openai-compatible", "gpt-4.1", {
    apiKey: "dialect-test-key",
    baseUrl: stub.baseUrl,
    useResponsesApi: true,
    responsesApi: true,
  });
  await expect(model.invoke("hello")).rejects.toThrow();
  expect(stub.paths).toEqual(["/v1/responses"]);
});

it("运行时模型额外参数不能覆盖所选模型、消息或供应商凭证", () => {
  for (const extraBody of [
    { model: "other" },
    { messages: [] },
    { input: "other" },
    { api_key: "secret" },
    { headers: { authorization: "other" } },
  ]) {
    expect(() =>
      resolveInstanceChatModel(
        "openai-compatible",
        "selected",
        { apiKey: "key", useResponsesApi: false },
        extraBody,
      ),
    ).toThrow(/覆盖|参数/);
  }
});

it("运行时缺Key在适配器解析处拒绝，不能读取环境凭证", () => {
  expect(() =>
    resolveInstanceChatModel("openai-compatible", "selected", { apiKey: "" }),
  ).toThrow(/API Key|凭证/);
});
