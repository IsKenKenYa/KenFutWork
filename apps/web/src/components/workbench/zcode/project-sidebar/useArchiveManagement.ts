import { useEffect, useRef, useState } from "react";
import type { ProjectTask } from "@zui/project-sidebar/contract.js";
import { useProjectDirectory } from "@zui/project-sidebar/ProjectDirectoryProvider.js";
import { archiveTaskKey } from "@zui/project-sidebar/archive-view.js";
import { useBaseWorkspaceServices } from "@zui/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { useConfirmDialog } from "@zui/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { logger } from "@zui/logger.js";

export type ArchiveOperation = "unarchive" | "delete";

export function useArchiveManagement() {
  const directory = useProjectDirectory();
  const { zcodeTaskService: service } = useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const confirm = useConfirmDialog();
  const { intl } = useZCodeIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ succeeded: number; failed: number; skipped: number } | null>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  const latest = useRef(directory);
  latest.current = directory;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const run = async (tasks: ProjectTask[], operation: ArchiveOperation) => {
    if (locked.current || !tasks.length) return;
    const candidates = [...new Map(tasks.filter((task) => task.archived).map((task) => [archiveTaskKey(task), task])).values()];
    if (!candidates.length) return;
    locked.current = true;
    setBusy(true);
    setResult(null);
    const counts = { succeeded: 0, failed: 0, skipped: 0 };
    try {
      if (operation === "delete" && !(await confirm({
        title: intl.formatMessage({ id: "archives.deleteTitle" }, { count: candidates.length }),
        description: intl.formatMessage({ id: "archives.deleteDescription" }),
        confirmLabel: intl.formatMessage({ id: "archives.delete" }),
        confirmVariant: "destructive",
      }))) return;
      for (const task of candidates) {
        if (!alive.current) break;
        if (!latest.current.tree.tasks.some((current) => archiveTaskKey(current) === archiveTaskKey(task) && current.archived)) {
          counts.skipped++;
          continue;
        }
        try {
          if (!task.taskControl) throw new Error("任务已改变，请刷新后重试。");
          const target = {
            taskId: task.taskId,
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            taskControl: task.taskControl,
          };
          if (operation === "delete") {
            const deleted = await service.deleteArchivedTask(target);
            if (!deleted) { counts.skipped++; continue; }
            removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
          } else await service.unarchiveTask(target);
          counts.succeeded++;
        } catch (error) {
          counts.failed++;
          logger.error("[archive-management] 任务操作失败", { taskId: task.taskId, operation, error });
        }
      }
      await latest.current.refresh();
      if (alive.current) setResult(counts);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return { ...directory, busy, result, run };
}
