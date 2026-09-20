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

/** ack 检查的节拍与总上限。 */
export const ACK_TIMEOUT_MS = 12_000;
export const ACK_POLL_MS = 6_000;
export const ACK_MAX_WAIT_MS = 90_000;

/** ack 等不到时的处置：继续等 / 换一条连接 / 判失败。 */
export type AckTimeoutDecision =
  | { action: "wait" }
  | { action: "reconnect" }
  | { action: "fail"; text: string };

/**
 * `agent.run` 发出后收不到 ack 时的处置口径（纯函数，只有这一处）。
 *
 * **为什么不能「看着连着」就直接报「请重试」**：实测（自建等效实例 + 真实模型）出现过
 * 这种状态——服务端那侧连接已经注销，客户端这一侧 socket 还开着（半开连接），于是
 * `ws.connected` 仍是 true、命令发得出去、服务端也真的把 run 跑了，但 ack 与随后所有
 * 事件都推不回来。用户在 12 秒后看到「请求未被确认，请重试。」——而那一轮其实在执行，
 * 照着提示重发一次就会**造出重复 run**（重复扣额度、重复副作用），正是本仓库明令避免的事。
 *
 * 现在的口径：只要还没到总上限，就先**换成一条新连接**（既有的重连对账 `resumeCanvas`
 * 会把在飞的 run 接回来，`run.failed` / 转录重载负责收尾）；到了总上限才如实报失败，
 * 并且把「服务端没确认」与「连接一直没恢复」分成两句不同的话。
 */
export function decideAckTimeout(input: {
  connected: boolean;
  waitedMs: number;
  maxWaitMs?: number;
}): AckTimeoutDecision {
  const maxWaitMs = input.maxWaitMs ?? ACK_MAX_WAIT_MS;
  if (input.waitedMs >= maxWaitMs) {
    return {
      action: "fail",
      text: input.connected
        ? "请求未被确认，请重试。"
        : "连接长时间未恢复，本轮未确认；重连后会自动同步，仍无输出再重试。",
    };
  }
  // 看着连着却收不到 ack = 半开连接的典型症状：换一条，让重连对账去接在飞的 run
  return input.connected ? { action: "reconnect" } : { action: "wait" };
}
