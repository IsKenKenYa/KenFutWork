import { createServer, type ServerResponse } from "node:http";
import { AGENT_GOVERNANCE_DEFAULTS } from "@kenfutwork/shared";
import { z } from "zod";
import { ENTER_PLAN_CALL } from "./enter-plan.fixture.js";
import { EXIT_PLAN_CALL, EXIT_PLAN_MARKDOWN } from "./exit-plan.fixture.js";
import {
  modelRequestSchema,
  writeModelChunk,
} from "./user-question-model.fixture.js";

// 仅安排实际公开历史长度，不改正式compact保留窗口。
export const PLAN_COMPACT_FILLER_TURNS =
  Math.floor(
    Math.max(
      AGENT_GOVERNANCE_DEFAULTS.compactKeepMessages,
      AGENT_GOVERNANCE_DEFAULTS.compactFallbackKeepMessages,
    ) / 2,
  ) + 1;
export const PLAN_COMPACT_SUMMARY =
  "COMPACT_SUMMARY_WITHOUT_APPROVAL_250acf91：已整理之前的普通工作上下文，继续下一项任务。";
export const PLAN_COMPACT_CONTINUE = "继续当前任务。";
export const PLAN_COMPACT_SUMMARY_INDEX = 3 + PLAN_COMPACT_FILLER_TURNS;
export const PLAN_COMPACT_CONTINUE_INDEX = PLAN_COMPACT_SUMMARY_INDEX + 1;
export const PLAN_COMPACT_TEXTS = [
  "PLAN_COMPACT_A_YOLO_HELD_45dc387b",
  "PLAN_COMPACT_B_ENTERED_EXIT_HELD_abbb6cd4",
  "PLAN_COMPACT_C_APPROVED_STOP_HELD_fa193598",
  ...Array.from(
    { length: PLAN_COMPACT_FILLER_TURNS },
    (_, index) => `PLAN_COMPACT_FILLER_REPLY_${index}_67be525a`,
  ),
  PLAN_COMPACT_SUMMARY,
  "PLAN_COMPACT_NEW_RUN_HELD_f2402b18",
];

const requestSchema = modelRequestSchema
  .extend({ model: z.string().min(1), stream: z.boolean().optional() })
  .passthrough();
type Request = z.infer<typeof requestSchema>;

function finishResponse(
  response: ServerResponse,
  request: Request,
  index: number,
) {
  const text = PLAN_COMPACT_TEXTS[index];
  if (request.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: `chatcmpl-plan-compact-${index + 1}`,
        object: "chat.completion",
        created: 1,
        model: request.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      }),
    );
    return;
  }
  const call =
    index === 0
      ? { id: ENTER_PLAN_CALL, name: "EnterPlanMode", args: {} }
      : index === 1
        ? {
            id: EXIT_PLAN_CALL,
            name: "ExitPlanMode",
            args: { plan: EXIT_PLAN_MARKDOWN },
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

/** 只控制外部模型输出；批准、compact Command、native与PG全部走正式管线。 */
export async function approvedPlanCompactFixture() {
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
      if (index >= PLAN_COMPACT_TEXTS.length) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "计划compact收到阶段之外的模型请求。" },
          }),
        );
        return;
      }
      // 正常调用由原provider默认streaming配置提供；摘要也接受实际nonstream请求。
      if (body.stream !== true && index !== PLAN_COMPACT_SUMMARY_INDEX) {
        response.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "正常模型请求未使用原SSE配置。" },
          }),
        );
        return;
      }
      if (body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "close",
        });
        writeModelChunk(response, index + 1, {
          role: "assistant",
          content: PLAN_COMPACT_TEXTS[index],
        });
      }
      // nonstream摘要保持实际HTTP等待，finish时才返回完整ChatCompletion JSON。
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
    throw new Error("计划compact外部模型地址不可读取。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    texts: PLAN_COMPACT_TEXTS,
    finish(index: number) {
      const response = responses[index];
      const observed = requests[index];
      if (
        !response ||
        !observed ||
        response.destroyed ||
        response.writableEnded
      )
        throw new Error("计划compact模型流未打开或已结束。");
      finishResponse(response, observed.body, index);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
