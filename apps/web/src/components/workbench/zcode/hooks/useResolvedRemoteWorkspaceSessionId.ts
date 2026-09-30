/**
 * zcode 照搬：`@/hooks/useResolvedRemoteWorkspaceSessionId.ts`（references/zcode/packages/ui/src/hooks/useResolvedRemoteWorkspaceSessionId.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）。
 */

import {
  resolveWorkspaceRemoteSessionId,
  type WorkspaceServiceResolverState,
} from "@zui/lib/workspaceServiceResolver";
import { useRemoteWorkspaceSessionStore } from "@zui/store/remoteWorkspaceSessionStore";
import { useTabStore } from "@zui/store/TabStoreProvider";
import { isWorkspaceTab, type WorkspaceTabState } from "@zui/store/tabStore";

function resolveRemoteWorkspaceSessionIdForTarget<TServices>(params: {
  workspacePath: string | null | undefined;
  preferredRemoteSessionId?: string | null;
  workspaceIdentity?: string | null;
  remoteTarget?: unknown;
  activeTab?: WorkspaceTabState | null;
  state: WorkspaceServiceResolverState<TServices>;
}): string | null {
  if (!params.workspacePath) {
    return null;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const matchingActiveTab =
    params.activeTab &&
    (workspaceIdentity
      ? params.activeTab.workspaceIdentity?.trim() === workspaceIdentity
      : params.activeTab.workspacePath === params.workspacePath)
      ? params.activeTab
      : null;
  const activeTabWorkspaceIdentity =
    matchingActiveTab?.workspaceIdentity?.trim() || undefined;
  const explicitRemoteSessionId = [
    params.preferredRemoteSessionId,
    matchingActiveTab?.remoteSessionId,
  ].find((candidateSessionId): candidateSessionId is string =>
    Boolean(
      candidateSessionId && params.state.sessionsById[candidateSessionId],
    ),
  );

  return (
    resolveWorkspaceRemoteSessionId(
      {
        workspacePath: params.workspacePath,
        workspaceIdentity: workspaceIdentity ?? activeTabWorkspaceIdentity,
        remoteSessionId: explicitRemoteSessionId,
        // 缺少 identity 也可能是 local workspace，不能一律伪造成旧 remote tab。
        // 只有精确匹配的 active tab，或调用方已定位的目标 tab 真正携带 remoteTarget 时，
        // 才开放旧数据的 path fallback。
        remoteTarget: matchingActiveTab?.remoteTarget ?? params.remoteTarget,
      },
      params.state,
    ) ?? null
  );
}

export function useResolvedRemoteWorkspaceSessionId(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): string | null {
  const activeWorkspaceTab = useTabStore((state) => {
    if (!workspacePath || !state.activeTabId) {
      return null;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab)) {
      return null;
    }

    if (workspaceIdentity) {
      return activeTab.workspaceIdentity?.trim() === workspaceIdentity.trim()
        ? activeTab
        : null;
    }

    return activeTab.workspacePath === workspacePath ? activeTab : null;
  });

  return useRemoteWorkspaceSessionStore((state) =>
    resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath,
      // exactOptionalPropertyTypes：可选属性仅在有意义时展开（null 语义保持透传）。
      ...(preferredRemoteSessionId === undefined
        ? {}
        : { preferredRemoteSessionId }),
      ...(workspaceIdentity === undefined ? {} : { workspaceIdentity }),
      ...(remoteTarget === undefined ? {} : { remoteTarget }),
      ...(activeWorkspaceTab === undefined
        ? {}
        : { activeTab: activeWorkspaceTab }),
      state,
    }),
  );
}
