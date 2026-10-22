import { SessionPane } from "@zui/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@zui/v4/V4ConversationContext.js";
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
    };
    __codePublicSessionDispose?: () => void;
  }
}

const bootstrap = window.__codePublicSessionBootstrap;
if (!bootstrap) throw new Error("原组件浏览器缺少实际会话配置");
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
  client.setViewerContextResolver(() => ({
    kind: "task",
    taskId: bootstrap.sessionId,
  }));
  releaseServices = bindCodeWorkspaceServices(client);
  const Providers = await loadCodePublicHostProviders();
  const scope = {
    workspacePath: bootstrap.workspacePath,
    workspaceIdentity: JSON.stringify([
      bootstrap.projectId,
      bootstrap.workspacePath,
    ]),
  };
  root.render(
    <Providers client={client}>
      <V4PaneConversationProvider scope={scope}>
        <SessionPane
          paneId="actual-model-menu-pane"
          sessionId={bootstrap.sessionId}
          rootSessionId={bootstrap.sessionId}
          {...scope}
        />
      </V4PaneConversationProvider>
    </Providers>,
  );
  document.documentElement.dataset.codePublicSessionState = "ready";
} catch (error) {
  document.documentElement.dataset.codePublicSessionState = "error";
  root.render(<div role="alert">{String(error)}</div>);
  throw error;
}
