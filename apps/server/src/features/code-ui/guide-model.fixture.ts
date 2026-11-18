import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { modelRequestSchema } from "./user-question-model.fixture.js";

export const GUIDE_MODEL_A = "stop-model";
export const GUIDE_MODEL_B = "guide-model-b";
export const guideModelText = (model: string) =>
  `GUIDE_MODEL_HTTP_ECHO:${model}`;

const requestSchema = modelRequestSchema
  .extend({
    model: z.string().min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean() }).optional(),
  })
  .passthrough();

type Request = z.infer<typeof requestSchema>;
type ObservedRequest = { body: Request; closed: boolean };

function writeDelta(
  response: ServerResponse,
  request: Request,
  index: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-guide-model-${index + 1}`,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage: null,
    })}\n\n`,
  );
}

/** 仅替换外部OpenAI-compatible HTTP/SSE；回复与用量按实际request.model归属。 */
export async function guideModelFixture() {
  const requests: ObservedRequest[] = [];
  const responses: ServerResponse[] = [];
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
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const index = requests.length;
      const observed = { body, closed: false };
      requests.push(observed);
      responses.push(response);
      response.on("close", () => {
        observed.closed = true;
      });
      if (index >= 2) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "A/B guide tracer收到额外模型请求。" },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "close",
      });
      writeDelta(response, body, index, {
        role: "assistant",
        content: guideModelText(body.model),
      });
      // 两条真实流分别由测试finish；不按请求序号伪装B模型或B用量。
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
    throw new Error("A/B模型HTTP地址不可读取。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    finish(index: number) {
      const observed = requests[index];
      const response = responses[index];
      if (
        !observed ||
        !response ||
        response.destroyed ||
        response.writableEnded
      )
        throw new Error("A/B模型流尚未打开或已经结束。");
      const tokens =
        observed.body.model === GUIDE_MODEL_A
          ? { input: 10, output: 3 }
          : observed.body.model === GUIDE_MODEL_B
            ? { input: 20, output: 7 }
            : undefined;
      if (!tokens) throw new Error("实际HTTP请求选择了A/B之外的模型。");
      writeDelta(response, observed.body, index, {}, "stop");
      // OpenAI include_usage的末尾空choices；真实SDK负责将usage送到stream/end/native AI。
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-guide-model-${index + 1}`,
          object: "chat.completion.chunk",
          created: 1,
          model: observed.body.model,
          choices: [],
          usage: {
            prompt_tokens: tokens.input,
            completion_tokens: tokens.output,
            total_tokens: tokens.input + tokens.output,
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
