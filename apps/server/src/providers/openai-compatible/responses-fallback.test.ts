import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAIResponses } from "@langchain/openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInstanceChatModel, isResponsesUnavailable } from "./index.js";

/**
 * Responses 自动回落（阶段 E 收尾，②决议）：probe.responsesApi=true 的实例
 * 主用 Responses；网关返回 404/405 时**同请求无感回落** chat/completions，
 * 并触发缓存纠偏回调。真实 HTTP 桩验证（非桩类）——回落发生在 SDK 请求层。
 */

describe("isResponsesUnavailable（判定分类）", () => {
  it("404 + /responses 路径 → true；限流/余额类错误 → false", () => {
    expect(
      isResponsesUnavailable(
        new Error("POST https://gw.example/v1/responses: 404 Not Found"),
      ),
    ).toBe(true);
    expect(
      isResponsesUnavailable(
        new Error("405 Method Not Allowed for responses api"),
      ),
    ).toBe(true);
    expect(isResponsesUnavailable(new Error("429 Too Many Requests"))).toBe(
      false,
    );
    expect(isResponsesUnavailable(new Error("402 insufficient balance"))).toBe(
      false,
    );
    expect(isResponsesUnavailable(new Error("content policy violation"))).toBe(
      false,
    );
  });
});

describe("createInstanceChatModel（Responses 自动回落，真实 HTTP 桩）", () => {
  let server: Server;
  let baseUrl = "";
  const chatCompletionsHits: string[] = [];
  let responsesHits = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? "";
      if (url === "/v1/responses") {
        responsesHits++;
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Unknown request URL: /v1/responses" },
          }),
        );
        return;
      }
      if (url === "/v1/chat/completions") {
        chatCompletionsHits.push(url);
        // streaming:true → 必须回 SSE chunk（invoke 走流式聚合）
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"回落成功"},"finish_reason":null}]}\n\n' +
            'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
            "data: [DONE]\n\n",
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("probe.responsesApi=true：Responses 404 → 同请求自动回落 completions，回调触发一次", async () => {
    responsesHits = 0;
    chatCompletionsHits.length = 0;
    let fallbackCount = 0;
    const model = createInstanceChatModel(
      "gpt-x",
      {
        apiKey: "sk-probe",
        baseUrl,
        responsesApi: true,
      },
      undefined,
      () => {
        fallbackCount++;
      },
    );

    const result = await model.invoke([new HumanMessage("ping")]);
    expect(String(result.content)).toContain("回落成功");
    expect(chatCompletionsHits).toHaveLength(1);
    expect(fallbackCount).toBe(1);
    expect(responsesHits).toBe(1);
    expect(String((await model.invoke("再次请求")).content)).toContain(
      "回落成功",
    );
    expect(chatCompletionsHits).toHaveLength(2);
    expect(responsesHits).toBe(1);
    expect(fallbackCount).toBe(1);
  });

  it("probe 缺省（未探测）→ 直接走 completions，不碰 Responses", async () => {
    chatCompletionsHits.length = 0;
    responsesHits = 0;
    const model = createInstanceChatModel("gpt-x", {
      apiKey: "sk-probe",
      baseUrl,
    });

    const result = await model.invoke([new HumanMessage("ping")]);
    expect(String(result.content)).toContain("回落成功");
    expect(chatCompletionsHits).toHaveLength(1);
    expect(responsesHits).toBe(0);
  });

  it("probe 确认 Responses 后构造原生 Responses 模型", () => {
    const model = createInstanceChatModel("gpt-x", {
      apiKey: "k",
      baseUrl,
      responsesApi: true,
    });
    // 原生 API 类不受 ChatOpenAI 模型名称的方言启发式影响。
    expect(model).toBeInstanceOf(ChatOpenAIResponses);
  });
});
