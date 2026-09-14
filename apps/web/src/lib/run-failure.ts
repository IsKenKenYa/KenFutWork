/**
 * `run.failed` 事件 → 用户可见的失败说明。
 *
 * **为什么单独抽出来**：这里原先在 workbench 的流事件分支里直接写死
 * 「运行失败，请重试。」，把服务端 `error.message` 里的可读原因（例如
 * 「模型流已 180 秒没有任何输出（上游停滞）」「run 未绑定项目」）整个丢掉。
 * 用户因此无法判断该重试、换模型，还是先去建项目——实测被当成「不知道为什么
 * 就失败了」反馈过。抽成纯函数后口径只有一处，并可被测试锁死。
 */

/** 失败时的兜底文案（服务端没给原因才用）。 */
export const GENERIC_RUN_FAILURE_TEXT = "运行失败，请重试。";

export function describeRunFailure(event: unknown): string {
  const message = (event as { error?: { message?: unknown } } | null)?.error
    ?.message;
  if (typeof message !== "string") {
    return GENERIC_RUN_FAILURE_TEXT;
  }
  return message.trim() || GENERIC_RUN_FAILURE_TEXT;
}
