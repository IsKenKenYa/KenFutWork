import type { AgentMiddleware } from "langchain";

/**
 * LLM 请求级重试中间件（DEC-18）：`llmRequestMaxRetries`（含首次）与
 * `llmInfiniteRetry`（用户显式开启）两个治理设置的**消费方**。
 *
 * 定位与边界：
 * - 挂在 `wrapModelCall` 上，对内建模型与 BYOK 实例模型**统一**生效（两者都在
 *   这一层发起模型调用），不需要动各 provider 的构造参数；
 * - 只重试**可重试错误**（429/5xx/超时/网络抖动）；400 类语法与鉴权错误一次都不
 *   多打——无限重试也不是无脑重试（kimi `KIMI_CODE_INFINITE_RETRY` 同口径）；
 * - 信号中止立即停止：用户取消 > 一切重试意图；
 * - 退避 1s 起指数翻倍、30s 封顶（测试可注入 delayMs）。
 * 底层 SDK 自带的重试与本中间件是叠加关系（先 SDK 后本层），如实知悉。
 */

const RETRYABLE_PATTERN =
  /(429|rate.?limit|too many requests|\b5\d\d\b|internal server|bad gateway|service unavailable|overloaded|timeout|timed out|econn|enotfound|eai_again|socket|fetch failed|network)/i;

export function isRetryableLlmError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : String(error ?? "");
  return RETRYABLE_PATTERN.test(message);
}

export function createLlmRequestRetryMiddleware(options: {
  /** 最大尝试次数（含首次；<1 视为 1）。infinite=true 时忽略。 */
  maxAttempts: number;
  /** 用户显式开启的无限重试。 */
  infinite: boolean;
  signal?: AbortSignal;
  /** 退避注入点（测试用）；默认 1s 起指数翻倍、30s 封顶。 */
  delayMs?: (ms: number) => Promise<void>;
}): AgentMiddleware {
  const delay =
    options.delayMs ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    name: "llmRequestRetry",
    async wrapModelCall(
      request: unknown,
      handler: (req: unknown) => Promise<unknown>,
    ) {
      const maxAttempts = options.infinite
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.floor(options.maxAttempts));
      const signal =
        (request as { config?: { signal?: AbortSignal } }).config?.signal ??
        options.signal;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        attempt += 1;
        try {
          return await handler(request);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (attempt >= maxAttempts) throw error;
          if (!isRetryableLlmError(error)) throw error;
          await delay(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
          if (signal?.aborted) throw error;
        }
      }
    },
  } as unknown as AgentMiddleware;
}
