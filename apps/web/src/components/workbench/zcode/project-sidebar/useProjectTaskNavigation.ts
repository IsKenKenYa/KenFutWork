import { useCallback, useLayoutEffect, useRef } from "react";
import type { ProjectSidebarProps, ProjectTree } from "@zui/project-sidebar/contract.js";
import { logger } from "@zui/logger.js";
import { toast } from "@zui/components/ui/toast.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { useTabStore } from "@zui/store/TabStoreProvider.js";

/** 打开任务才绑定 workspace；列表 mutation 不借导航创建 scope。 */
export function useProjectTaskNavigation(
  props: ProjectSidebarProps,
  tree: ProjectTree,
): ProjectSidebarProps["onSelectTask"] {
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const sequence = useRef(0);
  useLayoutEffect(() => () => { sequence.current++; }, []);
  const latest = useRef({ props, tree, activeWorkspaceIdentity });
  useLayoutEffect(() => {
    latest.current = { props, tree, activeWorkspaceIdentity };
  });
  return useCallback((path, taskId, identity, _remoteSessionId, unreadAt, unreadObservation) => {
    const request = ++sequence.current;
    const { props, tree, activeWorkspaceIdentity } = latest.current;
    const readFocus = () => props.workspacePath
      ? useZCodeSessionStore.getState().getWorkspaceState(props.workspacePath, activeWorkspaceIdentity ?? undefined)
      : undefined;
    const originFocus = readFocus();
    const isCurrent = () =>
      sequence.current === request &&
      latest.current.activeWorkspaceIdentity === activeWorkspaceIdentity &&
      readFocus()?.activeTaskId === originFocus?.activeTaskId &&
      readFocus()?.draftFocusVersion === originFocus?.draftFocusVersion;
    const open = async () => {
      const task = tree.tasks.find((item) =>
        item.taskId === taskId &&
        (item.workspaceIdentity || item.workspacePath) === (identity || path));
      if (!task || task.hostId !== "local") throw new Error("project.task-not-found");
      if (!isCurrent()) return;
      props.onSelectTask(path, taskId, identity, undefined, unreadAt, unreadObservation);
    };
    void open().catch((error) => {
      logger.error("[project-sidebar] 打开任务失败", error);
      toast(String(error));
    });
  }, []);
}
