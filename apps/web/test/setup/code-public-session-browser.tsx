import { DndContext } from "@dnd-kit/core";
import {
  horizontalListSortingStrategy,
  SortableContext,
} from "@dnd-kit/sortable";
import { SortableSidePaneTabTrigger } from "@zui/app-shell/SidePaneTabTrigger.js";
import { Tabs, TabsList } from "@zui/components/ui/tabs.js";
import { useZCodeIntl } from "@zui/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@zui/lib/codeViewer.js";
import type { CodeViewerSidePaneTab } from "@zui/lib/workspaceSidePane.js";
import { PreviewPane } from "@zui/PreviewPane.js";
import { SessionPane } from "@zui/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@zui/v4/V4ConversationContext.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeHttpChannelClient } from "../../src/components/workbench/zcode/host/httpChannelClient.js";
import { setSurfaceApiBase } from "../../src/components/workbench/zcode/host/surfaceApi.js";
import { bindCodeWorkspaceServices } from "../../src/components/workbench/zcode/host/workspaceServices.js";
import { loadCodePublicHostProviders } from "./code-public-host-ui.js";
import "@zui/styles.css";

declare global {
  interface Window {
    __codePublicSessionBootstrap?: {
      accessToken: string;
      workspacePath: string;
      projectId: string;
      sessionId: string;
      clientId: string;
      newDraft?: boolean;
      workspaceShell?: boolean;
      initialPreview?: {
        type?: "file" | "image";
        path: string;
        title: string;
        mediaType: string;
      };
    };
    __codePublicSessionDispose?: () => void;
  }
}

const providedBootstrap = window.__codePublicSessionBootstrap;
if (!providedBootstrap) throw new Error("原组件浏览器缺少实际会话配置");
const bootstrap = providedBootstrap;
delete window.__codePublicSessionBootstrap;
localStorage.setItem("zcode-v4-client-id:v1", bootstrap.clientId);
setSurfaceApiBase(window.location.origin);
const client = new CodeHttpChannelClient({
  apiBase: window.location.origin,
  accessToken: bootstrap.accessToken,
});
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("原组件浏览器缺少页面容器");
const root = createRoot(rootElement);
let releaseServices: (() => void) | undefined;
let disposed = false;
const dispose = () => {
  if (disposed) return;
  disposed = true;
  root.unmount();
  releaseServices?.();
  client.dispose();
};
window.__codePublicSessionDispose = dispose;
window.addEventListener("pagehide", dispose, { once: true });

try {
  await client.connect();
  await client.openWorkspace(bootstrap.workspacePath, bootstrap.projectId);
  client.setViewerContextResolver(() =>
    bootstrap.newDraft
      ? { kind: "project", projectId: bootstrap.projectId }
      : { kind: "task", taskId: bootstrap.sessionId },
  );
  releaseServices = bindCodeWorkspaceServices(client);
  const Providers = await loadCodePublicHostProviders();
  const scope = {
    workspacePath: bootstrap.workspacePath,
    workspaceIdentity: JSON.stringify([
      bootstrap.projectId,
      bootstrap.workspacePath,
    ]),
  };
  function PublicSessionSurface() {
    const { intl } = useZCodeIntl();
    const publicSessionId = bootstrap.newDraft ? null : bootstrap.sessionId;
    const [preview, setPreview] = useState<CodeViewerSource | null>(() =>
      bootstrap.initialPreview
        ? {
            ...bootstrap.initialPreview,
            type: bootstrap.initialPreview.type ?? "image",
            ...scope,
            viewerScope: { kind: "task", taskId: bootstrap.sessionId },
          }
        : null,
    );
    const session = (
      <SessionPane
        paneId="actual-model-menu-pane"
        sessionId={publicSessionId}
        {...(publicSessionId ? { rootSessionId: publicSessionId } : {})}
        {...scope}
      />
    );
    if (!bootstrap.initialPreview) return session;
    const previewTab: CodeViewerSidePaneTab | null = preview
      ? {
          id: "public-preview-tab",
          type: "code-viewer",
          source: preview,
          sourceKey: preview.path ?? null,
          ownerTaskId: publicSessionId,
          workspaceKey: scope.workspaceIdentity,
        }
      : null;
    return (
      <main style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <section style={{ width: "52%", minWidth: 0 }}>{session}</section>
        <section
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {preview && previewTab ? (
            <>
              <Tabs value={previewTab.id}>
                <DndContext>
                  <SortableContext
                    items={[previewTab.id]}
                    strategy={horizontalListSortingStrategy}
                  >
                    <TabsList>
                      <SortableSidePaneTabTrigger
                        tab={previewTab}
                        title={preview.title}
                        closeTabLabel={intl.formatMessage(
                          { id: "sidePane.closeTab" },
                          { title: preview.title },
                        )}
                        closeTabMenuLabel={intl.formatMessage({
                          id: "sidePane.closeCurrentTab",
                        })}
                        closeOtherTabsLabel={intl.formatMessage({
                          id: "sidePane.closeOtherTabs",
                        })}
                        closeAllTabsLabel={intl.formatMessage({
                          id: "sidePane.closeAllTabs",
                        })}
                        diffBadgeLabel={intl.formatMessage({
                          id: "diff.title",
                        })}
                        isActive
                        onActivateTab={() => setPreview(preview)}
                        onCloseTab={() => setPreview(null)}
                        onCloseOtherTabs={() => setPreview(preview)}
                        onCloseAllTabs={() => setPreview(null)}
                        canCloseOtherTabs={false}
                      />
                    </TabsList>
                  </SortableContext>
                </DndContext>
              </Tabs>
              <div style={{ flex: 1, minHeight: 0 }}>
                <PreviewPane
                  source={preview}
                  workspacePath={bootstrap.workspacePath}
                  markdownSelectionTarget={{
                    sessionId: publicSessionId,
                    workspaceKey: scope.workspaceIdentity,
                  }}
                  onClose={() => setPreview(null)}
                />
              </div>
            </>
          ) : null}
        </section>
      </main>
    );
  }
  if (bootstrap.workspaceShell) {
    const [{ Root }, { ZCodeIntlProvider }, platform, context] =
      await Promise.all([
        import("@zui/Root.js"),
        import("@zui/i18n/IntlProvider.js"),
        import("../../src/components/workbench/zcode/host/platform.js"),
        import(
          "../../src/components/workbench/zcode/host/workspaceServiceController.js"
        ),
      ]);
    root.render(
      <ZCodeIntlProvider
        initialLocale="zh-CN"
        settingService={client.services.settingService}
        broadcastService={client.services.broadcastService}
      >
        <Root
          services={client.services}
          platform={platform.createCodePlatform(client)}
          directoryServices={client.directoryServices()}
          onWorkspaceContextChange={context.createCodeWorkspaceContextResolver(
            client,
          )}
          initialUserInfo={null}
          initialWorkspaceAbsPath={bootstrap.workspacePath}
          initialWorkspaceIdentity={client.workspaces.identityFor(
            bootstrap.projectId,
            bootstrap.workspacePath,
          )}
          initialTaskId={bootstrap.sessionId}
          restoreSession={false}
          allowRemoteWorkspace={false}
          supportsEmbeddedBrowser={false}
        />
      </ZCodeIntlProvider>,
    );
  } else {
    root.render(
      <Providers client={client}>
        <V4PaneConversationProvider scope={scope}>
          <PublicSessionSurface />
        </V4PaneConversationProvider>
      </Providers>,
    );
  }
  document.documentElement.dataset.codePublicSessionState = "ready";
} catch (error) {
  document.documentElement.dataset.codePublicSessionState = "error";
  root.render(<div role="alert">{String(error)}</div>);
  throw error;
}
