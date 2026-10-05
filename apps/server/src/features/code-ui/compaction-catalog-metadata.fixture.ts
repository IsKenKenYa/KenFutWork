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
const FILLER_LINE =
  "catalog-budget-record alpha beta gamma delta epsilon zeta eta theta lambda.\n";

export const catalogUserText = (round: number) =>
  `CATALOG_COMPACT_USER_${round}_381dfc02：这是独占测试数据，只回复本轮标记。\n${FILLER_LINE.repeat(FILLER_LINES)}`;
export const catalogReplyText = (round: number, endpoint = "") =>
  `CATALOG_COMPACT_REPLY_${round}_29108dd6：本轮自然完成。${endpoint ? `实际端点：${endpoint}。` : ""}`;
export const catalogSummaryText = (ordinal: number, endpoint = "") =>
  `NATIVE_CATALOG_SUMMARY_${ordinal}_680f4c2a：较早测试上下文已经整理，继续当前用户任务。${endpoint ? `实际摘要端点：${endpoint}。` : ""}`;

const requestSchema = modelRequestSchema
  .extend({ model: z.string().min(1), stream: z.boolean().optional() })
  .passthrough();
type Request = z.infer<typeof requestSchema>;
export type CatalogObservedRequest = {
  body: Request;
  kind: "normal" | "summary";
  endpoint: string;
  round: number | null;
  summaryOrdinal: number | null;
  reply: string;
  closed: boolean;
};
export type CatalogModelFixtureOptions = {
  // 只用于测试区分同名模型的真实 HTTP 路由，不是生产 provider 配置入口。
  endpointLabels?: readonly string[];
  turns?: number;
  holdFromRound?: number;
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

function writeChunk(
  response: ServerResponse,
  body: Request,
  id: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
) {
  response.write(
    `data: ${JSON.stringify({
      id,
      created: 1,
      model: body.model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`,
  );
}

function finishReply(response: ServerResponse, body: Request, id: string) {
  writeChunk(response, body, id, {}, "stop");
  response.end("data: [DONE]\n\n");
}

function writeReply(
  response: ServerResponse,
  body: Request,
  id: string,
  text: string,
  held: boolean,
) {
  if (body.stream !== true) {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id,
        created: 1,
        model: body.model,
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
  writeChunk(response, body, id, { role: "assistant", content: text }, null);
  if (!held) finishReply(response, body, id);
}

/** 唯一被控制的外部 HTTP 模型；摘要按真实 prompt 识别，Guide 只控制普通 SSE 何时自然结束。 */
export async function catalogCompactionModelFixture(
  options: CatalogModelFixtureOptions = {},
) {
  const turns = options.turns ?? CATALOG_COMPACT_TURNS;
  const endpointLabels = options.endpointLabels ?? [""];
  const requests: CatalogObservedRequest[] = [];
  const errors: string[] = [];
  const latestRounds = new Map<string, number>();
  const heldResponses = new Map<
    CatalogObservedRequest,
    { response: ServerResponse; id: string }
  >();
  let normalRequests = 0;
  let summaryRequests = 0;

  function observe(body: Request, endpoint: string): CatalogObservedRequest {
    if (body.model !== CATALOG_COMPACT_MODEL)
      throw new Error("目录压缩脚本收到未显式选择的模型。");
    if (isNativeSummary(body)) {
      if (++summaryRequests > turns)
        throw new Error("native摘要请求超过有限测试脚本预算。");
      return {
        body,
        endpoint,
        kind: "summary",
        round: null,
        summaryOrdinal: summaryRequests,
        reply: catalogSummaryText(summaryRequests, endpoint),
        closed: false,
      };
    }
    if (body.stream !== true)
      throw new Error("原正常模型请求没有使用实际SSE配置。");
    if (++normalRequests > turns * 2)
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
      round < (latestRounds.get(endpoint) ?? 0) ||
      round < 1 ||
      round > turns
    )
      throw new Error("正常请求没有当前有限用户轮次，或发生历史倒退。");
    latestRounds.set(endpoint, round);
    return {
      body,
      endpoint,
      kind: "normal",
      round,
      summaryOrdinal: null,
      reply: catalogReplyText(round, endpoint),
      closed: false,
    };
  }

  const server = createServer(async (request, response) => {
    try {
      const endpoint = endpointLabels.find(
        (label) =>
          request.url === `${label ? `/${label}` : ""}/v1/chat/completions`,
      );
      if (request.method !== "POST" || endpoint === undefined) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = requestSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const observed = observe(body, endpoint);
      requests.push(observed);
      response.on("close", () => {
        observed.closed = true;
      });
      const id = `chatcmpl-catalog-${requests.length}`;
      const held =
        observed.kind === "normal" &&
        options.holdFromRound !== undefined &&
        (observed.round ?? 0) >= options.holdFromRound;
      if (held) heldResponses.set(observed, { response, id });
      writeReply(response, body, id, observed.reply, held);
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
  const baseUrlFor = (endpoint: string) => {
    if (!endpointLabels.includes(endpoint))
      throw new Error("测试未声明该实际HTTP端点。");
    return `http://127.0.0.1:${address.port}${endpoint ? `/${endpoint}` : ""}/v1`;
  };
  return {
    baseUrl: baseUrlFor(endpointLabels[0] ?? ""),
    baseUrlFor,
    requests,
    errors,
    finish(observed: CatalogObservedRequest) {
      const held = heldResponses.get(observed);
      if (!held || held.response.destroyed || held.response.writableEnded)
        throw new Error("实际普通SSE尚未保持打开或已经结束。");
      finishReply(held.response, observed.body, held.id);
      heldResponses.delete(observed);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
