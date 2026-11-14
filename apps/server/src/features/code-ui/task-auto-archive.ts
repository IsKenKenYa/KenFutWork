import { startPeriodicScan } from "../jobs/periodic-scan.js";
import type { CodeUiSessionRecord } from "./repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type TaskAutoArchivePreferences = {
  enabled?: unknown;
  olderThanDays?: unknown;
};

export type TaskAutoArchiveResult = {
  archived: string[];
  failed: Array<{ taskId: string; message: string }>;
  skipped: number;
};

function resolveCutoffDays(
  preferences: TaskAutoArchivePreferences,
): number | null {
  if (preferences.enabled !== true) return null;
  const days = preferences.olderThanDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days <= 0)
    return null;
  return days;
}

function eligible(root: CodeUiSessionRecord, cutoff: number): boolean {
  if (root.parent_session_id || root.deleted_at || root.archived) return false;
  // 只有已关闭且没有运行中 Run 的 Task 才能自动归档；其余留给用户处理。
  if (root.execution_state !== "ready" || root.active_run_id) return false;
  return new Date(root.updated_at).getTime() < cutoff;
}

/**
 * 任务自动归档的一次扫描：按实例偏好挑出超过天数的已关闭 Task，逐个走原归档
 * 路径（关闭执行资源、失效代际、刷新列表），不直接改 `archived` 列。
 *
 * 扫描在服务启动、偏好变更与进程内定时器触发时各跑一次；定时器只在服务运行
 * 期间生效，间隔见 `startTaskAutoArchiveTimer`。
 */
export async function runTaskAutoArchive(options: {
  preferences: TaskAutoArchivePreferences;
  listRoots: () => Promise<CodeUiSessionRecord[]>;
  archive: (taskId: string) => Promise<void>;
  now?: () => number;
}): Promise<TaskAutoArchiveResult> {
  const days = resolveCutoffDays(options.preferences);
  if (days === null) return { archived: [], failed: [], skipped: 0 };
  const cutoff = (options.now ?? Date.now)() - days * DAY_MS;
  const roots = await options.listRoots();
  const archived: string[] = [];
  const failed: Array<{ taskId: string; message: string }> = [];
  let skipped = 0;
  for (const root of roots) {
    if (!eligible(root, cutoff)) {
      skipped += 1;
      continue;
    }
    try {
      await options.archive(root.id);
      archived.push(root.id);
    } catch (error) {
      // 单个 Task 归档失败（例如正在关闭）不能中断整批；失败如实带给调用方记录。
      failed.push({
        taskId: root.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { archived, failed, skipped };
}

/**
 * 周期扫描按治理间隔触发，实现见 `features/jobs/periodic-scan.ts`。
 */
export function startTaskAutoArchiveTimer(options: {
  scan: () => Promise<void>;
  onError?: (error: unknown) => void;
  /** 来自治理设置（设置页可调），调用方必须显式传入。 */
  intervalMs: number;
}): () => void {
  return startPeriodicScan(options);
}
