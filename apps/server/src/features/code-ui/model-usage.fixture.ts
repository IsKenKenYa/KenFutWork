import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { modelRequestSchema } from "./user-question-model.fixture.js";

export const USAGE_READ_FILE = "usage-read.txt";
export const USAGE_READ_TEXT = "USAGE_REAL_READ_SENTINEL_470a9550";
export const USAGE_READ_CALL = "usage-original-read-call";
export const USAGE_FINAL_TEXT = "真实Read已完成，按两次模型调用结算用量。";

export const usageRequestSchema = modelRequestSchema
  .extend({
    model: z.string(),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).optional(),
  })
  .passthrough();

type Request = z.infer<typeof usageRequestSchema>;

function writeChunk(
  response: ServerResponse,
  request: Request,
  index: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-usage-${index + 1}`,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    })}\n\n`,
  );
}

function writeResponse(
  response: ServerResponse,
  request: Request,
  index: number,
) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    connection: "close",
  });
  if (index === 0) {
    writeChunk(response, request, index, {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: USAGE_READ_CALL,
          type: "function",
          function: {
            name: "Read",
            arguments: JSON.stringify({ file_path: USAGE_READ_FILE }),
          },
        },
      ],
    });
    writeChunk(response, request, index, {}, "tool_calls");
  } else {
    writeChunk(response, request, index, {
      role: "assistant",
      content: USAGE_FINAL_TEXT,
    });
    writeChunk(response, request, index, {}, "stop");
  }
  // OpenAI include_usage的末尾空choices块；实际SDK再将同一累计值送到stream/end。
  // 两次input固定10，output分别3/7，不能以input变化判定新调用，也不能叠加同call上报。
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-usage-${index + 1}`,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: index === 0 ? 3 : 7,
        total_tokens: index === 0 ? 13 : 17,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

/** 两次有限外部HTTP/SSE；Read/ToolMessage与stream/end事件均由真实运行链产生。 */
export async function modelUsageFixture() {
  const requests: Request[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        !request.url?.endsWith("/chat/completions")
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = usageRequestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const index = requests.length;
      requests.push(body);
      if (index >= 2) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "两次模型用量脚本收到额外请求。" },
          }),
        );
        return;
      }
      writeResponse(response, body, index);
    } catch (error) {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("真实用量模型HTTP地址不可读取。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
