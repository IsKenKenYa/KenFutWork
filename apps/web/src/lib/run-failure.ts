/**
 * `run.failed` 事件 → 用户可见的失败说明。
 *
 * **为什么单独抽出来**：这里原先在 workbench 的流事件分支里直接写死
 * 「运行失败，请重试。」，把服务端 `error.message` 里的可读原因（例如
 * 「模型流已 180 秒没有任何输出（上游停滞）」「run 未绑定项目」）整个丢掉。
 * 用户因此无法判断该重试、换模型，还是先去建项目——实测被当成「不知道为什么
 * 就失败了」反馈过。抽成纯函数后口径只有一处，并可被测试锁死。
 *
 * 服务端现在给的是「通用文案 + 原始错误（脱敏、截断）」，前端**原样透出**——
 * 只有一条笼统文案时，用户既判断不了原因，也没法把上游报错贴出来排查。
 */

/** 失败时的兜底文案（服务端没给原因才用）。 */
export const GENERIC_RUN_FAILURE_TEXT = "运行失败，请重试。";

export function describeRunFailure(event: unknown): string {
  const error = (
    event as { error?: { message?: unknown; code?: unknown } } | null
  )?.error;
  const message = error?.message;
  if (typeof message === "string" && message.trim()) {
    return message.trim();
  }
  // 连 message 都没有时别只说「运行失败」：带上服务端错误码，便于对着日志/DB 排查
  const code = typeof error?.code === "string" ? error.code : null;
  return code
    ? `${GENERIC_RUN_FAILURE_TEXT}（错误码 ${code}）`
    : GENERIC_RUN_FAILURE_TEXT;
}
