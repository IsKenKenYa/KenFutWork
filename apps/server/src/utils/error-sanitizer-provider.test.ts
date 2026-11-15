import { randomUUID } from "node:crypto";
import { getRetryable } from "@langchain/core/errors";
import { expect, it } from "vitest";
import { adaptDeepAgentStream } from "../agent/stream-adapter.js";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";
import { createInstanceChatModel } from "../providers/openai-compatible/index.js";
import {
  describeErrorDetail,
  sanitizeErrorForClient,
} from "./error-sanitizer.js";

it.each([
  [
    "循环引用",
    () => {
      const response: { data?: unknown } = {};
      response.data = response;
      return response;
    },
  ],
  ["BigInt 字段", () => ({ data: { providerRequestNumber: 12n } })],
])("供应商诊断包含%s时仍发送一次明确的失败通知", async (_name, metadata) => {
  const runId = randomUUID();
  const upstream = Object.assign(new Error("PRIVATE_PROVIDER_DETAIL"), {
    code: "insufficient_quota",
    response: { status: 429, ...metadata() },
  });
  const stream: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      yield { event: "on_chat_model_start", run_id: "provider" };
      throw upstream;
    },
  };
  const events = [];
  for await (const event of adaptDeepAgentStream({
    conversationId: randomUUID(),
    sessionId: randomUUID(),
    runId,
    stream,
  })) {
    events.push(event);
  }
  expect(
    events.filter(({ type }) =>
      ["run.failed", "run.completed", "run.canceled"].includes(type),
    ),
  ).toEqual([
    expect.objectContaining({
      type: "run.failed",
      runId,
      error: {
        code: "run_failed",
        message: "供应商额度不足，请检查账户余额。",
      },
    }),
  ]);
});

it.each([
  {
    code: "insufficient_quota",
    message: "调用失败 PRIVATE_PROVIDER_DETAIL",
    expected: "供应商额度不足，请检查账户余额。",
    retryable: false,
  },
  {
    code: "rate_limit_exceeded",
    message: "Out of credits PRIVATE_PROVIDER_DETAIL",
    expected: "供应商额度不足，请检查账户余额。",
    retryable: false,
  },
  {
    code: "rate_limit_exceeded",
    message: "Too many requests PRIVATE_PROVIDER_DETAIL",
    expected: "供应商请求过多，请稍后重试。",
    retryable: true,
  },
])(
  "真实 HTTP 429 的 $code / $retryable 显示对应处理建议",
  async ({ code, message, expected, retryable }) => {
    const provider = await heldModel({
      rejectStatus: 429,
      rejectError: { code, message },
    });
    try {
      const model = createInstanceChatModel("error-model", {
        apiKey: "local-test-key",
        baseUrl: provider.baseUrl,
        invocationMaxRetries: 0,
      });
      let failure: unknown;
      try {
        await model.invoke("检查错误提示");
      } catch (error) {
        failure = error;
      }
      expect(getRetryable(failure)).toBe(retryable);
      const wrapped = new Error("模型调用失败", {
        cause: new Error("供应商请求失败", { cause: failure }),
      });
      for (const error of [failure, wrapped]) {
        expect(sanitizeErrorForClient(error)).toBe(expected);
        expect(describeErrorDetail(error)).toContain("PRIVATE_PROVIDER_DETAIL");
      }
      const actionable = Object.assign(
        new Error("请在当前项目选择可用模型。", { cause: failure }),
        { exposeToClient: true },
      );
      expect(sanitizeErrorForClient(actionable)).toBe(
        "请在当前项目选择可用模型。",
      );
      const runId = randomUUID();
      const events = [];
      for await (const event of adaptDeepAgentStream({
        conversationId: randomUUID(),
        sessionId: randomUUID(),
        runId,
        stream: model.streamEvents("检查流式错误提示", { version: "v2" }),
      })) {
        events.push(event);
      }
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        runId,
        error: { code: "run_failed", message: expected },
      });
      expect(
        events.filter((event) => event.type === "run.failed"),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === "run.completed" || event.type === "run.canceled",
        ),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_DETAIL");
      expect(provider.requests).toHaveLength(2);
    } finally {
      await provider.close();
    }
  },
);
