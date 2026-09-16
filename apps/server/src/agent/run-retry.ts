/**
 * 失败重试判定（Code/Design 通用，run 层）。
 *
 * **为什么要重试**：上游（one-api + glm 一类代理）偶发「首 token 后停滞」或流异常中断，
 * 表现为整轮失败但重跑即好。此前失败就直接甩给用户，用户只能手动再发一次。
 *
 * **安全边界（关键）**：只在**本轮尚未执行任何工具**时重试。一旦有工具跑过，重试就可能
 * 重复施加副作用（重复写文件、重复下单、重复执行命令），故一律不重试。这条比「多救回来
 * 几次」重要得多。
 *
 * 判定做成纯函数：重试是「会重复触发的动作」，其边界必须可测。
 */

/** 缺省重试上限（含首次尝试；用户可在设置里改）。 */
export const DEFAULT_MAX_RUN_RETRIES = 10;
/** 上限护栏：防止把 0/负数/荒唐大数写进设置后无限重试。 */
export const MAX_RUN_RETRIES_UPPER_BOUND = 50;

/**
 * 永久性失败的特征：重试没有意义（配置/权限/绑定问题），只会白烧 10 次额度。
 * 只认「明确是永久」的，其余按可重试处理——因为最常见的失败恰恰是上游抖动。
 */
const PERMANENT_FAILURE_PATTERNS: readonly RegExp[] = [
  /canvasId is required/i,
  /must be scoped to a project/i,
  /未绑定项目/,
  /unauthorized/i,
  /forbidden/i,
  /额度|余额不足|plan|tier/i,
  // 认证/凭据类：令牌失效、凭证解不开——重试必然同样失败（实测：改名换掉 scrypt 盐后，
  // 每轮失败被重试 10 次，全是「认证失败」）
  /认证失败/,
  /credential|decrypt/i,
  /令牌|token 无效|invalid token/i,
];

/** 把设置里的值收敛到 [0, 上限]；非法值回落缺省。0 表示不重试。 */
export function clampMaxRunRetries(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_RUN_RETRIES;
  return Math.min(
    Math.max(Math.trunc(numeric), 0),
    MAX_RUN_RETRIES_UPPER_BOUND,
  );
}

/** 该失败是否值得重试（不看次数）。 */
export function isRetryableRunFailure(message: string | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text) return true;
  return !PERMANENT_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export interface RunRetryDecision {
  retry: boolean;
  /** 便于日志：为什么重试 / 为什么不重试。 */
  reason: string;
}

/**
 * 决定是否再跑一次。
 *
 * @param attempt 已完成的尝试次数（1 = 首次刚失败）
 * @param maxAttempts 上限（含首次）；0 = 不重试
 * @param failureMessage 服务端给出的可读失败原因
 * @param sawToolExecution 本轮是否已执行过工具（有副作用 → 绝不重试）
 * @param terminal 本轮的**显式终态**（由流事件判定）：成功与用户取消都不是失败
 */
export function decideRunRetry(input: {
  attempt: number;
  maxAttempts: number;
  failureMessage?: string | undefined;
  sawToolExecution: boolean;
  /**
   * 显式终态。事故背景：早期实现只在 `run.failed` 上记失败原因，于是「成功收场但没跑
   * 工具」的轮次里 `failureMessage` 仍是 undefined，而 `isRetryableRunFailure(undefined)`
   * 按「可重试」处理——**每轮纯对话都被重跑满 10 次**（实测：solo 与画布助手一次消息
   * 产出 10 个 run、10 倍 token，而用户看到的回复第一次就已经成功了）；用户取消同理，
   * 重试会把刚取消的轮次顶回去。
   */
  terminal?: "completed" | "canceled" | undefined;
}): RunRetryDecision {
  const maxAttempts = clampMaxRunRetries(input.maxAttempts);
  if (input.terminal === "completed") {
    return { retry: false, reason: "本轮已成功完成" };
  }
  if (input.terminal === "canceled") {
    return { retry: false, reason: "本轮已被取消，不重试" };
  }
  if (maxAttempts <= 1) {
    return { retry: false, reason: "重试上限为 1（即不重试）" };
  }
  if (input.attempt >= maxAttempts) {
    return {
      retry: false,
      reason: `已达重试上限（${maxAttempts} 次）`,
    };
  }
  if (input.sawToolExecution) {
    return { retry: false, reason: "本轮已执行工具，重试会重复施加副作用" };
  }
  if (!isRetryableRunFailure(input.failureMessage)) {
    return {
      retry: false,
      reason: `永久性失败，不重试：${(input.failureMessage ?? "").slice(0, 80)}`,
    };
  }
  return {
    retry: true,
    reason: `第 ${input.attempt} 次失败，准备第 ${input.attempt + 1} 次（上限 ${maxAttempts}）`,
  };
}
