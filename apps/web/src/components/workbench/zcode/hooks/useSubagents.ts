/**
 * zcode 照搬：`@/hooks/useSubagents.ts`（references/zcode/packages/ui/src/hooks/useSubagents.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */

import { useResolvedRemoteWorkspaceSessionId } from "@zui/hooks/useResolvedRemoteWorkspaceSessionId";
import { shouldEnableWorkspaceRpc } from "@zui/lib/workspaceRpcAvailability";
import type { ZCodeProvider } from "@zui/lib/zcode-shared";
import {
  getSubagentsContextKey,
  useSubagentsContextStore,
} from "@zui/store/subagentsContextStore";
import { useSubagentsStore } from "@zui/store/subagentsStore";
import { useTabStore } from "@zui/store/TabStoreProvider";
import {
  isWorkspaceTab,
  type WindowTabState,
  type WorkspaceTabState,
} from "@zui/store/tabStore";
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useServices } from "./useServices";

export function useSubagents(
  workspacePath: string | null,
  provider: ZCodeProvider,
  explicitWorkspaceIdentity?: string,
) {
  const { subagentsService } = useServices();
  const explicitIdentity = explicitWorkspaceIdentity?.trim() || undefined;
  const workspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!workspacePath) {
        return {
          workspaceIdentity: undefined,
          preferredRemoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeWorkspaceTab = state.activeTabId
        ? state.tabs.find((tab) => tab.id === state.activeTabId)
        : undefined;
      const matchesRequestedScope = (
        tab: WindowTabState,
      ): tab is WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        tab.workspacePath === workspacePath &&
        (!explicitIdentity ||
          tab.workspaceIdentity?.trim() === explicitIdentity);
      const matchedWorkspaceTab =
        activeWorkspaceTab && matchesRequestedScope(activeWorkspaceTab)
          ? activeWorkspaceTab
          : state.tabs.find(matchesRequestedScope);

      return {
        workspaceIdentity: matchedWorkspaceTab?.workspaceIdentity,
        preferredRemoteSessionId: matchedWorkspaceTab?.remoteSessionId,
        remoteTarget: matchedWorkspaceTab?.remoteTarget,
      };
    }),
  );
  const workspaceIdentity =
    explicitIdentity || workspaceRpcTarget.workspaceIdentity;
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    workspaceRpcTarget.preferredRemoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget: workspaceRpcTarget.remoteTarget,
  });
  const contextKey = workspacePath
    ? getSubagentsContextKey(workspacePath, provider, workspaceIdentity)
    : null;
  const context = useSubagentsContextStore((state) =>
    contextKey ? state.contexts[contextKey] : undefined,
  );
  const initialize = useSubagentsContextStore((state) => state.initialize);
  const refreshStore = useSubagentsContextStore((state) => state.refresh);
  const setEnabledStore = useSubagentsContextStore((state) => state.setEnabled);
  const legacyContext = useSubagentsStore(
    useShallow((state) => ({
      workspacePath: state.loadedWorkspacePath,
      workspaceIdentity: state.loadedWorkspaceIdentity,
      provider: state.loadedProvider,
      agents: state.agents,
      capability: state.capability,
      loading: state.loading,
      error: state.error,
    })),
  );
  const useLegacyContext =
    workspacePath !== null &&
    legacyContext.workspacePath === workspacePath &&
    legacyContext.workspaceIdentity === (workspaceIdentity ?? null) &&
    legacyContext.provider === provider;

  useEffect(() => {
    if (!workspacePath || !workspaceRpcEnabled) {
      // 远程 workspace 断连或 session 尚未重挂时，@ 面板会随输入框挂载预加载子智能体。
      // 这里先跳过 workspace RPC，避免 disconnected proxy 的内部错误码显示成红色子智能体提示。
      return;
    }
    if (context) return;
    void initialize(
      workspacePath,
      provider,
      subagentsService,
      workspaceIdentity,
    );
  }, [
    context,
    initialize,
    provider,
    subagentsService,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  const refresh = useCallback(async () => {
    if (!workspaceRpcEnabled) {
      return;
    }
    if (!workspacePath) return;
    await refreshStore(
      workspacePath,
      provider,
      subagentsService,
      workspaceIdentity,
    );
  }, [
    provider,
    refreshStore,
    subagentsService,
    workspaceIdentity,
    workspacePath,
    workspaceRpcEnabled,
  ]);

  const setEnabled = useCallback(
    async (agentId: string, enabled: boolean) => {
      if (!workspaceRpcEnabled) {
        return;
      }
      if (!workspacePath) return;
      await setEnabledStore(
        workspacePath,
        provider,
        agentId,
        enabled,
        subagentsService,
        workspaceIdentity,
      );
    },
    [
      provider,
      setEnabledStore,
      subagentsService,
      workspaceIdentity,
      workspacePath,
      workspaceRpcEnabled,
    ],
  );

  return useMemo(
    () => ({
      agents: workspaceRpcEnabled
        ? useLegacyContext
          ? legacyContext.agents
          : (context?.agents ?? [])
        : [],
      capability: workspaceRpcEnabled
        ? useLegacyContext
          ? legacyContext.capability
          : (context?.capability ?? null)
        : null,
      loading:
        workspaceRpcEnabled && workspacePath !== null
          ? useLegacyContext
            ? legacyContext.loading
            : !context || context.loading
          : false,
      error: workspaceRpcEnabled
        ? useLegacyContext
          ? legacyContext.error
          : (context?.error ?? null)
        : null,
      refresh,
      setEnabled,
    }),
    [
      context,
      legacyContext,
      refresh,
      setEnabled,
      useLegacyContext,
      workspacePath,
      workspaceRpcEnabled,
    ],
  );
}
