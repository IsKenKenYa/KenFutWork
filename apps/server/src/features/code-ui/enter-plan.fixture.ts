import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  GUIDE_MODE_FILE,
  GUIDE_MODE_FILE_CONTENT,
  GUIDE_MODE_WRITE_CALL,
} from "./guide-mode.fixture.js";
import {
  modelRequestSchema,
  writeModelChunk,
} from "./user-question-model.fixture.js";

export const ENTER_PLAN_CALL = "enter-plan-original-main-call";
export const ENTER_PLAN_TEXTS = [
  "ENTER_PLAN_A_YOLO_HELD_6a95fcee",
  "ENTER_PLAN_B_READONLY_WRITE_PROBE_9832efac",
  "Enter后正式Write已拒绝，保持规划状态完成当前轮。",
];

const requestSchema = modelRequestSchema
  .extend({
    model: z.string().min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
type Request = z.infer<typeof requestSchema>;

/** 只控制外部模型三段SSE；原SDK/工具管线产生Enter与Write的真实ToolMessage。 */
export async function enterPlanFixture() {
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
      if (index >= 3) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "Enter tracer收到三段之外的模型请求。" },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "close",
      });
      writeModelChunk(response, index + 1, {
        role: "assistant",
        content: ENTER_PLAN_TEXTS[index],
      });
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
    throw new Error("Enter模型HTTP地址不可读取。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    texts: ENTER_PLAN_TEXTS,
    finish(index: number) {
      const response = responses[index];
      if (!response || response.destroyed || response.writableEnded)
        throw new Error("Enter模型流未打开或已结束。");
      const call =
        index === 0
          ? { id: ENTER_PLAN_CALL, name: "EnterPlanMode", args: {} }
          : index === 1
            ? {
                id: GUIDE_MODE_WRITE_CALL,
                name: "Write",
                args: {
                  file_path: GUIDE_MODE_FILE,
                  content: GUIDE_MODE_FILE_CONTENT,
                },
              }
            : undefined;
      if (call) {
        writeModelChunk(response, index + 1, {
          tool_calls: [
            {
              index: 0,
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        });
        writeModelChunk(response, index + 1, {}, "tool_calls");
      } else writeModelChunk(response, index + 1, {}, "stop");
      response.end("data: [DONE]\n\n");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
