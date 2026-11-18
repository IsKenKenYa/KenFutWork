import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { modelRequestSchema } from "./user-question-model.fixture.js";

export const GUIDE_MODE_MODEL = "stop-model";
export const GUIDE_MODE_FILE = "guide-mode-forbidden-write-sentinel.txt";
export const GUIDE_MODE_FILE_CONTENT =
  "GUIDE_MODE_WRITE_MUST_NOT_CREATE_503e62d9";
export const GUIDE_MODE_WRITE_CALL = "guide-mode-original-write-call";
export const GUIDE_MODE_A_TEXT = "GUIDE_MODE_A_STREAM_HELD_2af841e7";
export const GUIDE_MODE_B_TEXT = "GUIDE_MODE_B_PENDING_WRITE_728eec41";
export const GUIDE_MODE_C_TEXT = "已收到真实拒绝，保持只读plan并完成当前轮。";
export const GUIDE_MODE_C_CYCLE_TEXT =
  "GUIDE_MODE_C_YOLO_WRITE_RESTORED_531b2e79";
export const GUIDE_MODE_D_TEXT = "同轮恢复yolo后已真实写入，完成折返回归。";
export const GUIDE_MODE_SUCCESS_CALL = "guide-mode-restored-yolo-write-call";
export const GUIDE_MODE_SUCCESS_CONTENT = "GUIDE_MODE_YOLO_REAL_WRITE_28dc74ea";

const requestSchema = modelRequestSchema
  .extend({
    model: z.string().min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
type Request = z.infer<typeof requestSchema>;

function writeChunk(
  response: ServerResponse,
  request: Request,
  index: number,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) {
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-guide-mode-${index + 1}`,
      object: "chat.completion.chunk",
      created: 1,
      model: request.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

/** 仅外部模型输出受控；真实Write调用与error ToolMessage由原SDK/正式工具管线产生。 */
export async function guideModeFixture(options: { cycle?: boolean } = {}) {
  const texts = options.cycle
    ? [
        GUIDE_MODE_A_TEXT,
        GUIDE_MODE_B_TEXT,
        GUIDE_MODE_C_CYCLE_TEXT,
        GUIDE_MODE_D_TEXT,
      ]
    : [GUIDE_MODE_A_TEXT, GUIDE_MODE_B_TEXT, GUIDE_MODE_C_TEXT];
  const requests: Array<{ body: Request; closed: boolean }> = [];
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
      if (index >= texts.length) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "mode guide tracer收到脚本之外的模型请求。" },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "close",
      });
      writeChunk(response, body, index, {
        role: "assistant",
        content: texts[index],
      });
      // A/B/C均保持真实SSE，测试观察公开边界后显式finish。
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
    throw new Error("mode guide模型地址不可读取。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    texts,
    finish(index: number) {
      const observed = requests[index];
      const response = responses[index];
      if (
        !observed ||
        !response ||
        response.destroyed ||
        response.writableEnded
      )
        throw new Error("mode guide模型流尚未打开或已经结束。");
      const write =
        index === 1
          ? { id: GUIDE_MODE_WRITE_CALL, content: GUIDE_MODE_FILE_CONTENT }
          : options.cycle && index === 2
            ? {
                id: GUIDE_MODE_SUCCESS_CALL,
                content: GUIDE_MODE_SUCCESS_CONTENT,
              }
            : undefined;
      if (write) {
        // 恶意B仍请求原Write；不伪造ToolMessage，不执行或替换内部工具。
        writeChunk(response, observed.body, index, {
          tool_calls: [
            {
              index: 0,
              id: write.id,
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({
                  file_path: GUIDE_MODE_FILE,
                  content: write.content,
                }),
              },
            },
          ],
        });
        writeChunk(response, observed.body, index, {}, "tool_calls");
      } else {
        writeChunk(response, observed.body, index, {}, "stop");
      }
      response.end("data: [DONE]\n\n");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
