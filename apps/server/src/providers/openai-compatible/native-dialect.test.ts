import { createServer, type Server } from "node:http";
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
