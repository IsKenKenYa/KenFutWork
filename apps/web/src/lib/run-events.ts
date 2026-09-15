/**
 * run 事件的客户端纯逻辑（重试路径）。
 *
 * 服务端失败后会自动整段重跑，并给这一轮**换一个新 runId**（`run.retrying` 带着新 id，
 * 同时按新 id 重新 ack）。客户端只按 `runId === 跟踪值` 过滤事件，若不认领新 id，
 * 这一轮后续事件（含终态）会被整段丢弃——任务永远停在「运行中」，用户看到的是
 * 一个永远转圈、永远没有回复的对话。
 */

/**
 * 整段重来前丢掉上一轮已流出的半截 assistant 消息（否则新内容会续写在残句之后）。
 * 只在末尾就是 assistant 时丢：末条是 user 说明本轮还没流出任何内容。
 */
export function dropPartialAssistantTail<T extends { role: string }>(
  messages: readonly T[],
): T[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return [...messages];
  return messages.slice(0, -1);
}
