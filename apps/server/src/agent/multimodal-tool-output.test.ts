import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemBackend } from "deepagents";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { loadServerEnv } from "../config/env.js";
import { createInstanceChatModel } from "../providers/openai-compatible/index.js";
import { createKenFutWorkDeepAgent } from "./deep-agent.js";

it("空文字工具结果先规范为字符串，后续预算内PNG完整进入Code模型请求", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kfw-multimodal-output-"));
  const png = new PNG({ width: 192, height: 128 });
  png.data = randomBytes(png.width * png.height * 4);
  const data = PNG.sync.write(png).toString("base64");
  expect(data.length).toBeGreaterThan(80_000);
  const requests: Array<{
    messages: Array<{ role: string; content: unknown }>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const messages = requests.at(-1)?.messages ?? [];
    const hasImage = messages.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "image_url"),
    );
    const hasEmptyToolText = messages.some(
      (message) =>
        message.role === "tool" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === "text" && block.text === "",
        ),
    );
    if (hasImage && hasEmptyToolText) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "1210",
            message: "multimodal history rejects empty tool text blocks",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const toolTurn = requests.length <= 2;
    const delta = toolTurn
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: requests.length === 1 ? "text-call" : "image-call",
              type: "function",
              function: {
                name: requests.length === 1 ? "observe_text" : "observe_image",
                arguments: "{}",
              },
            },
          ],
        }
      : { role: "assistant", content: "观察完成" };
    response.end(
      `data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: toolTurn ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("模型HTTP夹具未就绪");
    const backend = new FilesystemBackend({
      rootDir: directory,
      virtualMode: true,
    });
    const agent = createKenFutWorkDeepAgent({
      env: loadServerEnv({
        agentBackendMode: "filesystem",
        agentFilesRoot: directory,
      }),
      backendResult: {
        factory: () => backend,
        sandboxDir: directory,
        ephemeral: false,
      },
      model: createInstanceChatModel("test", {
        apiKey: "fixture",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        useResponsesApi: false,
        invocationMaxRetries: 0,
      }),
      preset: "code",
      systemPrompt: "观察图像",
      llmRetry: { maxAttempts: 1, infinite: false },
      kernelTools: [
        {
          name: "observe_text",
          description: "普通文字工具",
          scope: "code",
          parameters: { type: "object" },
          execute: async () => ({
            modelContent: [{ type: "text", text: "" }],
          }),
        },
        {
          name: "observe_image",
          description: "外部图像观察",
          scope: "code",
          parameters: { type: "object" },
          execute: async () => ({
            modelContent: [
              {
                type: "image",
                source_type: "base64",
                mime_type: "image/png",
                data,
              },
            ],
          }),
        },
      ],
    });
    for await (const _event of agent.streamEvents(
      { messages: [{ role: "user", content: "观察图像" }] },
      { version: "v2" },
    )) {
      /* 消费实际Harness */
    }
    expect(requests).toHaveLength(3);
    expect(
      requests[2]?.messages.find(
        (entry) =>
          entry.role === "tool" &&
          "tool_call_id" in entry &&
          entry.tool_call_id === "text-call",
      )?.content,
    ).toBe("");
    const message = requests[2]?.messages.find(
      (entry) => entry.role === "tool" && Array.isArray(entry.content),
    );
    const blocks = message?.content;
    if (!Array.isArray(blocks)) throw new Error("PNG被文字驱逐或转成文字结果");
    const image = blocks.find((block) => block.type === "image_url");
    const decoded = Buffer.from(
      image?.image_url?.url?.split(",")[1] ?? "",
      "base64",
    );
    expect([
      PNG.sync.read(decoded).width,
      PNG.sync.read(decoded).height,
    ]).toEqual([192, 128]);
    expect(createHash("sha256").update(decoded).digest("hex")).toBe(
      createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"),
    );
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
