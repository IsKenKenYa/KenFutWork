import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@zui/logger.js";
import type { TabStoreState } from "@zui/store/tabStore.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { usePaneLayoutStore } from "@zui/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@zui/v4/workbenchGroupStore.js";

export function useConversationWorkspaceActions({
  services,
  addTab,
  setWorkspaceActionError,
}: {
  services: IServiceAccessor;
  addTab: TabStoreState["addTab"];
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string, workspaceIdentity?: string) => {
      // 对话入口独立于当前项目焦点，不走跨窗口激活，也不写recentProjects。
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation", ...(workspaceIdentity ? { workspaceIdentity } : {}) });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspaceTarget = useCallback(async () => {
    try {
      const result = await services.fileService.ensureConversationWorkspace();
      setWorkspaceActionError(null);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [services.fileService, setWorkspaceActionError]);

  const handleResolveConversationWorkspace = useCallback(async () => {
    return (await handleResolveConversationWorkspaceTarget()).path;
  }, [handleResolveConversationWorkspaceTarget]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const target = await handleResolveConversationWorkspaceTarget();
    handleSelectConversationWorkspace(target.path, target.workspaceIdentity);
    return target.path;
  }, [handleResolveConversationWorkspaceTarget, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(async () => {
    try {
      const target = await handleResolveConversationWorkspaceTarget();
      handleSelectConversationWorkspace(target.path, target.workspaceIdentity);
      // “对话 +”是显式目标，不应被当前 split pane / workbench group 的项目绑定覆盖。
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore.getState().startDraft(target.path, undefined, target.workspaceIdentity);
    } catch {
      // handleResolveConversationWorkspace 已记录错误并保留当前 workspace。
    }
  }, [handleResolveConversationWorkspaceTarget, handleSelectConversationWorkspace]);

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}
