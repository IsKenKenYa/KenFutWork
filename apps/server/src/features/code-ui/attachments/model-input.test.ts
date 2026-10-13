import { once } from "node:events";
import { createServer } from "node:http";
import { HumanMessage } from "@langchain/core/messages";
import sharp from "sharp";
import { expect, it } from "vitest";
import { createInstanceChatModel } from "../../../providers/openai-compatible/index.js";
import { codeInputContent } from "./model-input.js";

it("PNG消息附件通过真实模型适配器生成对象形状的image_url并保留字节", async () => {
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const content = await codeInputContent(
    [
      {
        attachment: {
          ref: "code-attachment:fixture",
          fileName: "synthetic.png",
          mime: "image/png",
          bytes: bytes.length,
        },
        bytes,
      },
    ],
    {
      codeReadMaxBytes: 4096,
      codeReadPageCharacters: 8000,
      codeSearchMaxResults: 100,
      codeSearchMaxBytes: 4096,
      codePatchMaxBytes: 4096,
      codePdfMaxPages: 10,
      codePdfRenderScale: 1,
    },
    { image: true, pdf: false },
  );
  let body:
    | {
        messages: Array<{
          content: Array<{ type: string; image_url?: { url: string } }>;
        }>;
      }
    | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "红色" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("模型HTTP夹具未就绪");
    const model = createInstanceChatModel("fixture", {
      apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      useResponsesApi: false,
      invocationMaxRetries: 0,
    });
    await model.invoke([
      new HumanMessage({
        content: [{ type: "text", text: "查看图片" }, ...content],
      }),
    ]);
    const image = body?.messages[0]?.content.find(
      (block) => block.type === "image_url",
    );
    expect(image?.image_url).toEqual({
      url: `data:image/png;base64,${bytes.toString("base64")}`,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
