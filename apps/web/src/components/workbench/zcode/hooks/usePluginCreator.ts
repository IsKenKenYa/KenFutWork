import { useCallback, useMemo } from "react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { CreateTaskRequest } from "@zui/app-shell/types.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { toast } from "@zui/components/ui/toast.js";
import { isWorkspaceReadOnly } from "@zui/store/tabStore.js";
import { useTabStore, useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import { usePaneLayoutStore } from "@zui/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@zui/v4/workbenchNewTaskTarget.js";
import { useWorkbenchGroupStore } from "@zui/v4/workbenchGroupStore.js";

/** 创建插件：新任务以创造方式启动，由 agent 按创造指令写骨架并调用 install_plugin 安装。 */
export function usePluginCreator(
  onCreateTask: ((request?: CreateTaskRequest) => void) | undefined,
  fallbackWorkspace?: { workspacePath?: string | null; workspaceIdentity?: string | null },
) {
  const { intl } = useZCodeIntl();
  const tabStore = useTabStoreApi();
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const paneLayout = usePaneLayoutStore((state) => state);
  const group = useWorkbenchGroupStore((state) =>
    state.activeGroupId ? (state.groups[state.activeGroupId] ?? null) : null,
  );
  // 设置页可能在独立文档中运行，自身的 tabStore 未必有活动 workspace；
  // 此时用设置 Scope 解析出的 workspace 兜底，避免入口永久变灰。
  const target = useMemo(
    () =>
      resolveWorkbenchNewTaskTarget({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeGroup: group,
        paneLayout,
      }) ??
      (fallbackWorkspace?.workspacePath
        ? {
            workspacePath: fallbackWorkspace.workspacePath,
            ...(fallbackWorkspace.workspaceIdentity?.trim()
              ? { workspaceIdentity: fallbackWorkspace.workspaceIdentity }
              : {}),
          }
        : null),
    [activeWorkspaceIdentity, activeWorkspacePath, fallbackWorkspace, group, paneLayout],
  );
  const targetKey = target?.workspaceIdentity?.trim() || target?.workspacePath || "";
  const create = useCallback(() => {
    if (!onCreateTask) return;
    // 设置页运行在独立管理文档时没有自己的活动 workspace：新建任务的实际落点
    // 由 Code 壳解析。此时只读校验与 expectedWorkspaceKey 都交给壳，不能把入口判灰。
    if (
      target &&
      isWorkspaceReadOnly(tabStore.getState(), target.workspacePath, target.workspaceIdentity)
    ) {
      toast(intl.formatMessage({ id: "pluginCreator.unavailable" }), { variant: "warning" });
      return;
    }
    onCreateTask({
      provider: ZCODE_AGENT_PROVIDER,
      initialPrompt: "创建一个插件：\n",
      executionMode: "creative",
      ...(targetKey ? { expectedWorkspaceKey: targetKey } : {}),
    });
  }, [intl, onCreateTask, tabStore, target, targetKey]);
  return { create, busy: false, available: Boolean(onCreateTask) };
}
