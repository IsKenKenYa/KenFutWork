import { setImmediate, setTimeout } from "node:timers/promises";
import { getRetryable } from "@langchain/core/errors";
import { describe, expect, it } from "vitest";
import { heldModel } from "../features/code-ui/model-stream.fixture.js";
import { testInstanceModelConnectivity } from "../features/model-providers/model-connectivity.js";
import { createInstanceChatModel } from "../providers/openai-compatible/index.js";

import { createLlmRequestRetryMiddleware } from "./llm-retry-middleware.js";

type Handler = (request: { messages: string[] }) => Promise<string>;

function makeHandler(script: Array<Error | string>): {
  handler: Handler;
  calls: () => number;
} {
  let called = 0;
  const queue = [...script];
  const handler: Handler = async () => {
    called += 1;
    const next = queue.shift();
    if (typeof next === "string") return next;
    throw next ?? new Error("脚本耗尽");
  };
  return { handler, calls: () => called };
}

function run(middleware: unknown, handler: Handler) {
  const wrap = (
    middleware as {
      wrapModelCall: (req: unknown, hnd: unknown) => Promise<unknown>;
    }
  ).wrapModelCall.bind(middleware);
  return (request: {
    messages: string[];
    runtime?: { signal?: AbortSignal };
    config?: { signal?: AbortSignal };
  }) => wrap(request, handler) as Promise<string>;
}

describe("LLM 请求重试中间件（DEC-18）", () => {
  it.each([
    { status: 429, code: "insufficient_quota", message: "额度不足" },
    { status: 429, code: "rate_limit_exceeded", message: "Out of credits" },
    { status: 400, code: "invalid_request_error", message: "network 参数无效" },
    { status: 401, code: "invalid_api_key", message: "429 gateway 密钥无效" },
    { status: 403, code: "permission_denied", message: "timeout 权限不足" },
  ])(
    "SDK 已拒绝重试的 HTTP $status / $code 只发送一次",
    async ({ status, code, message }) => {
      const provider = await heldModel({
        rejectStatus: status,
        rejectError: { code, message },
      });
      const failures: unknown[] = [];
      try {
        const model = createInstanceChatModel("retry-model", {
          apiKey: "local-test-key",
          baseUrl: provider.baseUrl,
          invocationMaxRetries: 0,
        });
        const invoke = run(
          createLlmRequestRetryMiddleware({
            maxAttempts: 3,
            infinite: false,
            delayMs: () => Promise.resolve(),
          }),
          async () => {
            try {
              await model.invoke("检查不可重试错误");
            } catch (error) {
              failures.push(error);
              throw error;
            }
            return "请求成功";
          },
        );
        const outcome = await invoke({ messages: ["检查不可重试错误"] }).catch(
          (error: unknown) => error,
        );
        expect(getRetryable(outcome)).toBe(false);
        expect(outcome).toBe(failures[0]);
        expect(outcome).toMatchObject({ status });
        expect(provider.requests).toHaveLength(1);
        expect(failures).toHaveLength(1);
      } finally {
        await provider.close();
      }
    },
  );

  it("无限连接测试遇到供应商额度不足时只发送一次并返回原错误码", async () => {
    const provider = await heldModel({
      rejectStatus: 429,
      rejectError: { code: "insufficient_quota", message: "额度不足" },
    });
    try {
      const result = await testInstanceModelConnectivity(
        async () => ({
          instanceId: "local-provider",
          name: "本机测试供应商",
          protocol: "openai-compatible",
          apiKey: "local-test-key",
          baseUrl: provider.baseUrl,
          useResponsesApi: false,
          models: [{ id: "retry-model", name: "测试模型", capability: "chat" }],
          configRevision: 1,
        }),
        { instanceId: "local-provider", modelId: "retry-model" },
        { infinite: true, maxAttempts: 1, timeoutMs: 3000 },
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: "insufficient_quota" },
      });
      expect(result.error?.message).toContain("额度不足");
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.close();
    }
  });

  it("maxAttempts=1：不重试，失败直接抛", async () => {
    const middleware = createLlmRequestRetryMiddleware({
      maxAttempts: 1,
      infinite: false,
      delayMs: () => Promise.resolve(),
    });
    const { handler, calls } = makeHandler([
      new Error("429 too many requests"),
    ]);
    await expect(
      run(middleware, handler)({ messages: ["hi"] }),
    ).rejects.toThrow("429");
    expect(calls()).toBe(1);
  });

  it("可重试错误按次数重试并成功", async () => {
    const middleware = createLlmRequestRetryMiddleware({
      maxAttempts: 3,
      infinite: false,
      delayMs: () => Promise.resolve(),
    });
    const { handler, calls } = makeHandler([
      new Error("502 bad gateway"),
      new Error("upstream timeout"),
      "最终回答",
    ]);
    await expect(run(middleware, handler)({ messages: ["hi"] })).resolves.toBe(
      "最终回答",
    );
    expect(calls()).toBe(3);
  });

  it("不可重试错误（400 语法类/鉴权）不重试直接抛", async () => {
    const middleware = createLlmRequestRetryMiddleware({
      maxAttempts: 5,
      infinite: false,
      delayMs: () => Promise.resolve(),
    });
    const { handler, calls } = makeHandler([
      new Error("invalid_api_key: permission denied"),
    ]);
    await expect(
      run(middleware, handler)({ messages: ["hi"] }),
    ).rejects.toThrow("invalid_api_key");
    expect(calls()).toBe(1);
  });

  it("infinite=true：无视次数上限，直到成功或不可重试", async () => {
    let attempts = 0;
    const middleware = createLlmRequestRetryMiddleware({
      maxAttempts: 2,
      infinite: true,
      delayMs: () => Promise.resolve(),
    });
    const handler: Handler = async () => {
      attempts += 1;
      if (attempts < 7) throw new Error("503 service unavailable");
      return "终于成功";
    };
    await expect(run(middleware, handler)({ messages: ["hi"] })).resolves.toBe(
      "终于成功",
    );
    expect(attempts).toBe(7);
  });

  it("infinite=true 但信号中止时立即停止", async () => {
    const controller = new AbortController();
    const middleware = createLlmRequestRetryMiddleware({
      maxAttempts: 2,
      infinite: true,
      signal: controller.signal,
      delayMs: () => Promise.resolve(),
    });
    let attempts = 0;
    const handler: Handler = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("429 rate limit");
      controller.abort();
      throw new Error("429 rate limit");
    };
    await expect(
      run(middleware, handler)({ messages: ["hi"] }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(attempts).toBe(2);
  });

  it("收到真实 HTTP 429 后可立即取消等待，且不会发起第二次请求", async () => {
    const provider = await heldModel({ rejectStatus: 429 });
    const controller = new AbortController();
    const fallback = new AbortController();
    const deadline = new AbortController();
    const cancelled = new DOMException("用户停止任务", "AbortError");
    let responseStatus: number | undefined;
    let failed!: () => void;
    const failureObserved = new Promise<void>((resolve) => {
      failed = resolve;
    });
    try {
      const invoke = run(
        createLlmRequestRetryMiddleware({
          maxAttempts: 3,
          infinite: false,
          signal: fallback.signal,
        }),
        async ({ messages }) => {
          const response = await fetch(`${provider.baseUrl}/chat/completions`, {
            method: "POST",
            body: JSON.stringify({ messages }),
          });
          responseStatus = response.status;
          await response.text();
          failed();
          throw new Error(`HTTP ${response.status}`);
        },
      );
      const outcome = invoke({
        messages: ["检查退避取消"],
        runtime: { signal: controller.signal },
      }).catch((error: unknown) => error);
      await Promise.race([failureObserved, outcome]);
      await setImmediate();
      controller.abort(cancelled);
      const result = await Promise.race([
        outcome,
        setTimeout(500, "仍在等待重试", { signal: deadline.signal }),
      ]);
      expect(result).toBe(cancelled);
      expect(responseStatus).toBe(429);
      expect(provider.requests).toHaveLength(1);
      expect(fallback.signal.aborted).toBe(false);
    } finally {
      deadline.abort();
      fallback.abort();
      await provider.close();
    }
  });

  it("开始前配置已取消，不调用模型", async () => {
    const controller = new AbortController();
    const cancelled = new DOMException("请求已取消", "AbortError");
    controller.abort(cancelled);
    const { handler, calls } = makeHandler(["不应请求模型"]);
    await expect(
      run(
        createLlmRequestRetryMiddleware({ maxAttempts: 2, infinite: false }),
        handler,
      )({ messages: [], config: { signal: controller.signal } }),
    ).rejects.toBe(cancelled);
    expect(calls()).toBe(0);
  });
});
