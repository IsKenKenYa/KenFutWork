import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { ENTER_PLAN_CALL } from "./enter-plan.fixture.js";
import {
  GUIDE_MODE_FILE,
  GUIDE_MODE_SUCCESS_CALL,
  GUIDE_MODE_SUCCESS_CONTENT,
} from "./guide-mode.fixture.js";
import {
  modelRequestSchema,
  writeModelChunk,
} from "./user-question-model.fixture.js";

export const EXIT_PLAN_CALL = "exit-plan-original-main-approval-call";
export const EXIT_PLAN_MARKDOWN = [
  "# 原 Run 批准后的实施计划",
  "",
  "目标：在原 Task 的主目录验证计划批准解除只读规划，然后完成当前轮。",
  "",
  "## 实施步骤",
  "",
  "1. 通过 EnterPlanMode 开启规划，只读确认原 Task、Run 与授权代际。",
  "2. 通过 ExitPlanMode 展示本完整 Markdown，并等待实例主人明确批准。",
  `3. 批准后使用原 Write 工具写入主目录的 ${GUIDE_MODE_FILE}。`,
  "4. 保留批准文件的宿主相对引用和 SHA-256，自然结束同一 Run。",
  "",
  "## 验收",
  "",
  "- 未提供明确 approve 答案时继续等待，规划状态保持开启。",
  "- 批准后的文件正文逐字保存（包括中文与末尾换行）。",
  "- 主目录与附加目录、LocalActor、scopeGeneration 和 branchGeneration 不变。",
  "- 同一工具调用的批准事实、模型上下文和持久回执保持一致。",
  "",
].join("\n");
export const EXIT_PLAN_TEXTS = [
  "EXIT_PLAN_A_YOLO_HELD_34b63d19",
  "EXIT_PLAN_B_ENTERED_APPROVAL_HELD_7ea6c8af",
  "EXIT_PLAN_C_APPROVED_WRITE_HELD_31f07a23",
  "计划已由人明确批准，原主目录Write成功，完成同一轮。",
];

const requestSchema = modelRequestSchema
  .extend({
    model: z.string().min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();
type Request = z.infer<typeof requestSchema>;

function finishResponse(response: ServerResponse, index: number) {
  const call =
    index === 0
      ? { id: ENTER_PLAN_CALL, name: "EnterPlanMode", args: {} }
      : index === 1
        ? {
            id: EXIT_PLAN_CALL,
            name: "ExitPlanMode",
            args: { plan: EXIT_PLAN_MARKDOWN },
          }
        : index === 2
          ? {
              id: GUIDE_MODE_SUCCESS_CALL,
              name: "Write",
              args: {
                file_path: GUIDE_MODE_FILE,
                content: GUIDE_MODE_SUCCESS_CONTENT,
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
}

/** 只控制一个Run的四段外部SSE；不制造批准、文件或内部ToolMessage。 */
export async function exitPlanFixture() {
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
      if (index >= EXIT_PLAN_TEXTS.length) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "Exit tracer收到四段之外的模型请求。" },
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
        content: EXIT_PLAN_TEXTS[index],
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
    throw new Error("Exit模型HTTP地址不可读取。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    texts: EXIT_PLAN_TEXTS,
    finish(index: number) {
      const response = responses[index];
      if (!response || response.destroyed || response.writableEnded)
        throw new Error("Exit模型流未打开或已结束。");
      finishResponse(response, index);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
