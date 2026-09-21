/**
 * 工作台 UI 的展示格式化（对齐 ZCode 的呈现口径，纯逻辑便于单测）。
 */

/**
 * 路径叶子：工具行只显示文件名（`src/lib/a.ts` → `a.ts`），完整路径放 title。
 * 以 `/` 与 `\` 都切（Windows 路径的入参）。空串防御返回原值。
 */
export function getPathLeaf(path: string): string {
  if (!path) return path;
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * 任务相对时间（ZCode 同款口径）：<1 分钟「刚刚」、<60 分钟「N 分」、
 * <24 小时「N 小时」、否则「N 天」。future 时间戳（时钟偏差）按「刚刚」。
 * 接受毫秒数或 ISO 串；解析失败返回空串（调用方不渲染）。
 */
export function formatTaskRelativeTime(
  at: number | string,
  nowMs: number = Date.now(),
): string {
  const ts = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ts)) return "";
  const diffMs = Math.max(0, nowMs - ts);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
