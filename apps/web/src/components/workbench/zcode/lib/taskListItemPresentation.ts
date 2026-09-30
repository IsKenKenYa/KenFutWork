/**
 * zcode 照搬：`@/lib/taskListItemPresentation.ts`（references/zcode/packages/ui/src/lib/taskListItemPresentation.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
import type { ZCodeTaskMeta } from "@zui/lib/zcode-shared";
import type { TaskListRowActivity } from "@zui/v4/taskListRowActivity";

export function deriveTaskLeadingIndicator(
  task: ZCodeTaskMeta,
  activity: TaskListRowActivity | null,
): "error" | "unread" | "loading" | "none" {
  if (activity?.phase === "error") {
    return "error";
  }

  // 搜索结果或 sessions-index 尚未水合时可能没有 activity sidecar。
  // 这种情况仅回退持久化 error；一旦有 sessions-index，phase 就是实时权威。
  if (!activity && task.status === "error") {
    return "error";
  }

  // unread 是 tasks-index membership 字段，蓝点必须直接读取当前
  // query-cache row；不再回退旧 Zustand map，避免两个未读权威互相打架。
  if (typeof task.unreadAt === "number") {
    return "unread";
  }

  if (activity?.phase === "prewarming" || activity?.phase === "running") {
    return "loading";
  }

  // persisted status=running 只说明上次落盘时还没收到终态，不代表新进 app 后仍在实时运行。
  // loading 必须由当前 runtime 明确证明，否则历史列表会把上次未完成的 task 一直显示成转圈。
  return "none";
}

export function formatTaskRelativeTime(
  timestamp: number,
  intl: {
    formatMessage: (
      desc: { id: string },
      values?: Record<string, string>,
    ) => string;
  },
): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return intl.formatMessage({ id: "taskList.justNow" });
  if (minutes < 60) {
    return intl.formatMessage(
      { id: "taskList.minutesAgo" },
      { minutes: String(minutes) },
    );
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return intl.formatMessage(
      { id: "taskList.hoursAgo" },
      { hours: String(hours) },
    );
  }

  const days = Math.floor(hours / 24);
  return intl.formatMessage({ id: "taskList.daysAgo" }, { days: String(days) });
}
