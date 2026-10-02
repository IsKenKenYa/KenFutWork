import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import type { UserInfo } from "@zcode/shared";
import { TooltipProvider } from "@zui/components/ui/tooltip.js";
import { ServiceProvider } from "@zui/hooks/useServices.js";
import { PlatformProvider } from "@zui/hooks/usePlatform.js";
import { StoreProvider } from "@zui/store/StoreProvider.js";
import { TabStoreProvider, useTabStore, useTabStoreApi } from "@zui/store/TabStoreProvider.js";
import { isSettingsTab } from "@zui/store/tabStore.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import { DiffsWorkerPoolProvider } from "@zui/root/DiffsWorkerPoolProvider.js";
import { AssistantCodeCommentFeatureProvider } from "@zui/AssistantCodeCommentFeatureProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@zui/settings/CodingPlanUpgradeDialogProvider.js";
import { ConfirmDialogHost } from "@zui/ConfirmDialog.js";
import { RootWorkspaceContent } from "@zui/root/RootWorkspaceContent.js";
import { RootStartupLoading } from "@zui/root/RootStartupLoading.js";
import { ScopedErrorBoundary } from "@zui/ErrorBoundary.js";
import { DirectoryBrowser } from "@zui/DirectoryBrowser.js";
import { useRootWorkspaceActions } from "@zui/root/useRootWorkspaceActions.js";
import { useRootProviderSettingsSnapshot } from "@zui/root/useRootProviderSettingsSnapshot.js";
import { reloadProviderSettingsSnapshot } from "@zui/lib/providerSettingsSnapshot.js";
import { registerBaseWorkspaceServices } from "@zui/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import { useWorkbenchGroupStore } from "@zui/v4/workbenchGroupStore.js";
import { usePaneLayoutStore } from "@zui/v4/paneLayoutStore.js";
import { isRendererReloadNavigation } from "@zui/lib/rendererNavigation.js";
import { createWebPlatform } from "./upstream/browserPlatform.js";
import { CodeHttpChannelClient, type CodeHostConfig } from "./httpChannelClient.js";
import "@zui/styles.css";

interface Workspace { projectId: string; canvasId: string; name: string; path: string; }

const params = new URLSearchParams(window.location.search);
const config: CodeHostConfig = { apiBase: params.get("api") ?? window.location.origin, ...(params.get("workspace") ? { workspacePath: params.get("workspace")! } : {}) };
const client = new CodeHttpChannelClient(config);
const services = client.services;
const platform = createWebPlatform();
const root = createRoot(document.getElementById("root")!);

function WorkspaceHost({ workspaces }: { workspaces: Workspace[] }) {
  const tabStore = useTabStoreApi();
  const { intl } = useZCodeIntl();
  const activePath = useTabStore((state) => state.activeWorkspacePath);
  const settingsActive = useTabStore((state) => state.tabs.some((tab) => tab.id === state.activeTabId && isSettingsTab(tab)));
  const [directoryOpen, setDirectoryOpen] = useState(workspaces.length === 0);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [, setOAuthError] = useState<string | null>(null);
  useRootProviderSettingsSnapshot(services);
  const actions = useRootWorkspaceActions({
    intl, platform, services, tabStoreApi: tabStore, addTab: tabStore.getState().addTab,
    activeWorkspacePath: activePath, activeWorkspaceIdentity: null,
    supportsSettings: true, allowOpenWorkspace: true, preferDirectoryBrowser: true,
    openDirectoryBrowser: () => setDirectoryOpen(true), refreshProviderState: reloadProviderSettingsSnapshot,
    updateAppSettings: (patch) => services.settingService.update(patch), setOAuthError, setUser,
    workbenchGroupClientMode: "web-remote-replayable",
  });
  useEffect(() => {
    const workspace = workspaces.find((item) => item.path === config.workspacePath) ?? workspaces[0];
    if (!workspace) return;
    tabStore.getState().addTab(workspace.path);
    if (!isRendererReloadNavigation()) {
      useWorkbenchGroupStore.getState().deactivateActiveGroup();
      usePaneLayoutStore.getState().resetToPrimaryPane();
      useZCodeSessionStore.getState().startDraft(workspace.path);
    }
  }, [tabStore, workspaces]);

  if (!activePath && workspaces.length > 0) return <RootStartupLoading label="打开 Code 工作目录" />;

  return <>
    <RootWorkspaceContent
      workspaceScopedServices={services} baseFeedbackService={services.feedbackService}
      workspaceShellPath={activePath ?? ""} activeWorkspacePath={activePath} isSettingsTabActive={settingsActive}
      handleCreateTask={actions.handleCreateTask} handleCreateConversationTask={actions.handleCreateConversationTask}
      handleResolveConversationWorkspace={actions.handleResolveConversationWorkspace}
      handleOpenWorkspace={actions.handleOpenWorkspace} handleOpenFolderFromWorkspaceMenu={actions.handleOpenFolderFromWorkspaceMenu}
      handleCreateScratchWorkspace={actions.handleCreateScratchWorkspace} handleBackFromSettings={actions.handleBackFromSettings}
      handleConnectRemote={async () => { throw new Error("当前宿主尚无远程连接插件"); }}
      handleSelectRemoteProject={async () => { throw new Error("当前宿主尚无远程连接插件"); }}
      handleCancelRemoteProject={async () => { throw new Error("当前宿主尚无远程连接插件"); }}
      handleReconnectRemoteWorkspace={async () => { throw new Error("当前宿主尚无远程连接插件"); }}
      remoteWorkspaceSessions={[]} allowRemoteWorkspace={false} allowOpenWorkspace={true}
      supportsEmbeddedBrowser={false} reconnectingRemoteWorkspaceKeys={[]} remoteWorkspaceErrorByWorkspaceKey={{}} reconnectingRemoteWorkspaceLogsByWorkspaceKey={{}} user={user}
    />
    {directoryOpen && <DirectoryBrowser services={services} onSelect={(path) => { void actions.handleSelectProject(path).then(() => setDirectoryOpen(false)); }} onCancel={() => setDirectoryOpen(false)} />}
    <ConfirmDialogHost />
  </>;
}

function CodeHost({ workspaces }: { workspaces: Workspace[] }) {
  return <LucideProvider strokeWidth={1.5}><TooltipProvider>
    <ServiceProvider services={services}><PlatformProvider platform={platform}>
      <ZCodeIntlProvider initialLocale="zh-CN" settingService={services.settingService} broadcastService={services.broadcastService}>
        <StoreProvider broadcastService={services.broadcastService}><TabStoreProvider><DiffsWorkerPoolProvider>
          <AssistantCodeCommentFeatureProvider enabled><CodingPlanUpgradeDialogProvider>
            <ScopedErrorBoundary scope="kenfutwork-code-host"><WorkspaceHost workspaces={workspaces} /></ScopedErrorBoundary>
          </CodingPlanUpgradeDialogProvider></AssistantCodeCommentFeatureProvider>
        </DiffsWorkerPoolProvider></TabStoreProvider></StoreProvider>
      </ZCodeIntlProvider>
    </PlatformProvider></ServiceProvider>
  </TooltipProvider></LucideProvider>;
}

root.render(<RootStartupLoading label="加载 Code 工作台" />);
try {
  await client.connect();
  registerBaseWorkspaceServices(services);
  const { workspaces } = await client.request<{ workspaces: Workspace[] }>("/api/code-ui/workspaces");
  root.render(<CodeHost workspaces={workspaces} />);
} catch (error) {
  console.error("Code 工作台启动失败", error);
  root.render(<RootStartupLoading label={error instanceof Error ? error.message : "Code 工作台启动失败"} busy={false} />);
}
window.addEventListener("pagehide", () => client.dispose(), { once: true });
