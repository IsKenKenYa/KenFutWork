/**
 * 任务工作时间（R1-1）的纯逻辑：格式化与解析。
 *
 * 时间戳来自 WS 事件（`run.started` / `run.completed` 等的 ISO 字符串）；
 * 运行中用本地时钟估算，结束后用起止差值定格。纯函数便于单测。
 */

/** ISO 时间戳 → epoch ms；无效输入返回 null（调用方决定兜底显示）。 */
export function parseTimestampMs(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 秒数 → 「N 秒」/「N 分 N 秒」/「N 时 N 分 N 秒」（对齐参考图「已工作 39 分 6 秒」口径）。 */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} 时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

/** 由起止时间算已工作秒数；结束缺省视为「仍在进行」，用 now 估算。 */
export function elapsedSecondsBetween(
  startMs: number,
  endMs: number | undefined,
  nowMs: number,
): number {
  return Math.max(0, Math.round(((endMs ?? nowMs) - startMs) / 1000));
}
