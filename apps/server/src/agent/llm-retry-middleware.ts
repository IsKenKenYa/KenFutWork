import { setTimeout } from "node:timers/promises";
import { getRetryable } from "@langchain/core/errors";
import type { AgentMiddleware } from "langchain";

/**
 * LLM 请求级重试中间件（DEC-18）：`llmRequestMaxRetries`（含首次）与
 * `llmInfiniteRetry`（用户显式开启）两个治理设置的**消费方**。
 *
 * 普通调用、摘要与独立评估共用请求执行函数；运行模型不再叠加 SDK 重试。
 *
 * 定位与边界：
 * - 普通调用挂在 `wrapModelCall` 上，摘要与独立评估直接消费执行函数；
 * - 只重试**可重试错误**（429/5xx/超时/网络抖动）；400 类语法与鉴权错误一次都不
 *   多打——无限重试也不是无脑重试（kimi `KIMI_CODE_INFINITE_RETRY` 同口径）；
 * - 信号中止立即停止：用户取消 > 一切重试意图；
 * - 退避 1s 起指数翻倍、30s 封顶（测试可注入 delayMs）。
 */

const RETRYABLE_PATTERN =
  /(429|rate.?limit|too many requests|\b5\d\d\b|internal server|bad gateway|service unavailable|overloaded|timeout|timed out|econn|enotfound|eai_again|socket|fetch failed|network)/i;

export function isRetryableLlmError(error: unknown): boolean {
  // MiddlewareError 会包装 SDK 错误；任何明确的禁止重试判定都继续保留。
  const seen = new Set<unknown>();
  let current = error;
  let retryable = false;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const classified = getRetryable(current);
    if (classified === false) return false;
    const message =
      current instanceof Error
        ? `${current.name} ${current.message}`
        : String(current);
    retryable ||= classified === true || RETRYABLE_PATTERN.test(message);
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return retryable;
}

export interface LlmRequestRetryPolicy {
  /** 最大尝试次数（含首次；<1 视为 1）。infinite=true 时忽略。 */
  maxAttempts: number;
  /** 用户显式开启的无限重试。 */
  infinite: boolean;
}

export interface LlmRequestRetryOptions extends LlmRequestRetryPolicy {
  signal?: AbortSignal;
  /** 退避注入点（测试用）；默认 1s 起指数翻倍、30s 封顶。 */
  delayMs?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function withLlmRequestRetry<T>(
  invoke: () => Promise<T>,
  options: LlmRequestRetryOptions,
): Promise<T> {
  const delay =
    options.delayMs ??
    ((ms: number, signal?: AbortSignal) =>
      setTimeout(ms, undefined, { signal }));

  const maxAttempts = options.infinite
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(options.maxAttempts));
  const signal = options.signal;
  let attempt = 0;
  while (true) {
    signal?.throwIfAborted();
    attempt += 1;
    try {
      return await invoke();
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt >= maxAttempts || !isRetryableLlmError(error)) throw error;
      try {
        await delay(Math.min(30_000, 1_000 * 2 ** (attempt - 1)), signal);
      } catch (delayError) {
        signal?.throwIfAborted();
        throw delayError;
      }
    }
  }
}

export function createLlmRequestRetryMiddleware(
  options: LlmRequestRetryOptions,
): AgentMiddleware {
  return {
    name: "llmRequestRetry",
    async wrapModelCall(
      request: unknown,
      handler: (req: unknown) => Promise<unknown>,
    ) {
      const source = request as {
        runtime?: { signal?: AbortSignal };
        config?: { signal?: AbortSignal };
      };
      // SDK 的模型中间件用 runtime.signal；兼容显式调用传入的信号。
      const signals = [
        source.runtime?.signal,
        source.config?.signal,
        options.signal,
      ].filter((candidate) => candidate !== undefined);
      const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      return withLlmRequestRetry(() => handler(request), {
        ...options,
        ...(signal ? { signal } : {}),
      });
    },
  } as unknown as AgentMiddleware;
}
