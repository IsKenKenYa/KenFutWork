import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { modelRequestSchema } from "./user-question-model.fixture.js";

// 固定测试数据与有限外部脚本预算，不是 Agent 运行时治理值。
export const CATALOG_COMPACT_MODEL = "catalog-window-custom-69e18cf7";
export const CATALOG_COMPACT_WINDOW = 24_000;
export const CATALOG_COMPACT_MAX_OUTPUT = 22_000;
export const CATALOG_COMPACT_EXPECTED_TRIGGER = 4_000;
export const CATALOG_COMPACT_TURNS = 12;
const FILLER_LINES = 48;
const MAX_NORMAL_REQUESTS = CATALOG_COMPACT_TURNS * 2;
const MAX_SUMMARY_REQUESTS = CATALOG_COMPACT_TURNS;
const FILLER_LINE =
  "catalog-budget-record alpha beta gamma delta epsilon zeta eta theta lambda.\n";

export const catalogUserText = (round: number) =>
  `CATALOG_COMPACT_USER_${round}_381dfc02：这是独占测试数据，只回复本轮标记。\n${FILLER_LINE.repeat(FILLER_LINES)}`;
export const catalogReplyText = (round: number) =>
  `CATALOG_COMPACT_REPLY_${round}_29108dd6：本轮自然完成。`;
export const catalogSummaryText = (ordinal: number) =>
  `NATIVE_CATALOG_SUMMARY_${ordinal}_680f4c2a：较早测试上下文已经整理，继续当前用户任务。`;

const requestSchema = modelRequestSchema
  .extend({ model: z.string().min(1), stream: z.boolean().optional() })
  .passthrough();
type Request = z.infer<typeof requestSchema>;
export type CatalogObservedRequest = {
  body: Request;
  kind: "normal" | "summary";
  round: number | null;
  summaryOrdinal: number | null;
  reply: string;
};

export function catalogModelText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("\n");
}

/** deepagents 1.14.0 的实际 createSummary 使用单 HumanMessage/default prompt；只识别，不生成自家摘要事件。 */
function isNativeSummary(request: Request): boolean {
  if (request.messages.length !== 1 || request.messages[0]?.role !== "user")
    return false;
  const text = catalogModelText(request.messages[0].content);
  return (
    text.startsWith("You are a conversation summarizer.") &&
    text.includes("Conversation to summarize:") &&
    text.trimEnd().endsWith("Summary:")
  );
}

function writeReply(
  response: ServerResponse,
  body: Request,
  id: string,
  text: string,
) {
  const common = { id, created: 1, model: body.model };
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        ...common,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
      }),
    );
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    connection: "close",
  });
  for (const [delta, finishReason] of [
    [{ role: "assistant", content: text }, null],
    [{}, "stop"],
  ] as const) {
    response.write(
      `data: ${JSON.stringify({
        ...common,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

/** 唯一被控制的外部 HTTP 模型；普通回应/实际 native summary 都接受真实 stream 形态，脚本总调用量有界。 */
export async function catalogCompactionModelFixture() {
  const requests: CatalogObservedRequest[] = [];
  const errors: string[] = [];
  let normalRequests = 0;
  let summaryRequests = 0;
  let latestRound = 0;
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
      if (body.model !== CATALOG_COMPACT_MODEL)
        throw new Error("目录压缩脚本收到未显式选择的模型。");
      let observed: CatalogObservedRequest;
      if (isNativeSummary(body)) {
        if (++summaryRequests > MAX_SUMMARY_REQUESTS)
          throw new Error("native摘要请求超过有限测试脚本预算。");
        observed = {
          body,
          kind: "summary",
          round: null,
          summaryOrdinal: summaryRequests,
          reply: catalogSummaryText(summaryRequests),
        };
      } else {
        if (body.stream !== true)
          throw new Error("原正常模型请求没有使用实际SSE配置。");
        if (++normalRequests > MAX_NORMAL_REQUESTS)
          throw new Error("正常请求超过有限测试脚本预算。");
        const markers = body.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => [
            ...catalogModelText(message.content).matchAll(
              /CATALOG_COMPACT_USER_(\d+)_381dfc02/gu,
            ),
          ]);
        const round = Number(markers.at(-1)?.[1]);
        if (
          !Number.isInteger(round) ||
          round < latestRound ||
          round < 1 ||
          round > CATALOG_COMPACT_TURNS
        )
          throw new Error("正常请求没有当前有限用户轮次，或发生历史倒退。");
        latestRound = round;
        observed = {
          body,
          kind: "normal",
          round,
          summaryOrdinal: null,
          reply: catalogReplyText(round),
        };
      }
      requests.push(observed);
      writeReply(
        response,
        body,
        `chatcmpl-catalog-${requests.length}`,
        observed.reply,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      response.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            code: "fixture_script_exhausted",
            message,
          },
        }),
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
    throw new Error("目录压缩外部模型HTTP地址不可读。");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
