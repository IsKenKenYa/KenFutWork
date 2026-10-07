import { describe, expect, it } from "vitest";

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
  return (request: { messages: string[] }) =>
    wrap(request, handler) as Promise<string>;
}

describe("LLM 请求重试中间件（DEC-18）", () => {
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
    ).rejects.toThrow("429");
    expect(attempts).toBe(2);
  });
});
