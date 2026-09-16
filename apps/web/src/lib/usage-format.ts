/**
 * 使用统计的展示格式化（纯函数，便于单测）。
 *
 * **为什么不放在组件里**：同一套口径会被汇总卡与将来的图表复用；放进组件就只能在
 * 渲染测试里间接触发，容易漂移。
 */

/**
 * 秒 → 中文时长（R4-2 汇总卡「最长聊天时长」）。
 *
 * 取到「分」为止：统计页关心的是量级（聊了多久），不是秒级精度；不足一分钟给「不到 1 分钟」
 * 而不是「0 分钟」——后者会被读成「没有数据」。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 1) return "不到 1 分钟";
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  return parts.join(" ");
}
