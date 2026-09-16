/**
 * 左侧栏对话列表的展示规则（纯逻辑，单测护航）。
 *
 * 两件事：
 * - **分组预览**：一个工作目录下可能有几十条对话，默认只露前 `SESSION_PREVIEW_LIMIT` 条，
 *   其余收进「显示更多」，否则单个工作目录就把侧栏撑满；
 * - **行图标形态**：在跑的转圈、跑完但没打开过的用实心气泡、其余空心气泡。
 */

/** 分组默认预览条数（超出的收进「显示更多」）。 */
export const SESSION_PREVIEW_LIMIT = 5;

export type TaskIndicator = "running" | "unread" | "read";

/**
 * 一行的图标形态：
 * - `running`（确实有一轮在跑）→ 转圈；转圈优先于未读——正在跑的对话不是「未读」；
 * - 否则未读 → 实心气泡；已读 → 空心气泡。
 *
 * `running` 由调用方判定（只在**本页确实在跑的那条**上为真）：任务数据里的
 * `status: "running"` 只代表「起过表、还没看到终态事件」，进程重启/关页留下的
 * 陈旧记录会永远停在 running——按它转圈会得到一排永远转的图标。
 */
export function resolveTaskIndicator(
  running: boolean,
  unread: boolean,
): TaskIndicator {
  if (running) return "running";
  return unread ? "unread" : "read";
}

/**
 * 预览切片：未展开时只给前 `limit` 条，并给出被收起的条数（0 表示无需「显示更多」）。
 */
export function previewGroup<T>(
  items: readonly T[],
  expanded: boolean,
  limit: number = SESSION_PREVIEW_LIMIT,
): { visible: readonly T[]; hiddenCount: number } {
  if (expanded || items.length <= limit) {
    return { visible: items, hiddenCount: 0 };
  }
  return { visible: items.slice(0, limit), hiddenCount: items.length - limit };
}
