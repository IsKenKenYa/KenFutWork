import type { CodeUiWorkspace, InstanceContext } from "@kenfutwork/shared";
import type { UserInfo } from "@zcode/shared";
import type { HelloMessage } from "@zcode/shared/zcode-protocol-v4";
import { ScopedErrorBoundary } from "@zui/ErrorBoundary.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { Root } from "@zui/Root.js";
import { RootStartupLoading } from "@zui/root/RootStartupLoading.js";
import { ensureAgentV4ConnectionHandshake } from "@zui/v4/agentV4ConnectionHandshake.js";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { CuaSnapshotReader } from "./cuaScreenshotSectionAdapter.js";
import {
  type CodeHostConfig,
  CodeHttpChannelClient,
} from "./httpChannelClient.js";
import { navigateToDesign, requestParentBootstrap } from "./parentBridge.js";
import { createCodePlatform } from "./platform.js";
import { createCodeWorkspaceContextResolver } from "./workspaceServiceController.js";
import { bindCodeWorkspaceServices } from "./workspaceServices.js";
import "@zui/styles.css";

const params = new URLSearchParams(window.location.search);
const bootstrap =
  window.parent !== window ? await requestParentBootstrap(window.parent) : null;
const workspacePath = params.get("workspace");
const config: CodeHostConfig = {
  apiBase: bootstrap?.apiBase ?? params.get("api") ?? window.location.origin,
  ...(bootstrap?.accessToken ? { accessToken: bootstrap.accessToken } : {}),
  ...(workspacePath ? { workspacePath } : {}),
};
const client = new CodeHttpChannelClient(config);
const readCuaSnapshot = client.readCuaSnapshot.bind(client);
const platform = createCodePlatform(client);
const onWorkspaceContextChange = createCodeWorkspaceContextResolver(client);
const element = document.getElementById("root");
if (!element) throw new Error("Code 宿主缺少 root 容器");
const root = createRoot(element);
let releaseWorkspaceServices: (() => void) | undefined;

function CodeHost({
  workspace,
  user,
  clientMode,
}: {
  workspace?: CodeUiWorkspace;
  user: UserInfo | null;
  clientMode: HelloMessage["clientMode"];
}) {
  const services = useSyncExternalStore(
    client.subscribeServices,
    () => client.services,
  );
  const workspaceIdentity = workspace
    ? client.workspaces.identityFor(workspace.projectId, workspace.path)
    : null;
  return (
    <CuaSnapshotReader value={readCuaSnapshot}>
      <ZCodeIntlProvider
        initialLocale="zh-CN"
        settingService={services.settingService}
        broadcastService={services.broadcastService}
      >
        <ScopedErrorBoundary scope="kenfutwork-code-host">
          <Root
            services={services}
            platform={platform}
            isMacDesktop={platform.supportsComputerUse === true}
            directoryServices={client.directoryServices()}
            onWorkspaceContextChange={onWorkspaceContextChange}
            initialUserInfo={user}
            {...(workspace ? { initialWorkspaceAbsPath: workspace.path } : {})}
            {...(workspaceIdentity
              ? { initialWorkspaceIdentity: workspaceIdentity }
              : {})}
            workbenchGroupClientMode={clientMode}
            onInterfaceModeChange={(mode) => {
              if (mode === "office") navigateToDesign();
            }}
            preferDirectoryBrowser
            restoreSession
            allowRemoteWorkspace={false}
            supportsEmbeddedBrowser={false}
            assistantCodeCommentCardsEnabled
            initialWorkspaceLoadingFallback={
              <RootStartupLoading label="打开 Code 工作目录" />
            }
          />
        </ScopedErrorBoundary>
      </ZCodeIntlProvider>
    </CuaSnapshotReader>
  );
}

root.render(<RootStartupLoading label="加载 Code 工作台" />);
try {
  if (!bootstrap) await client.request<InstanceContext>("/api/instance");
  await client.connect();
  const hello = await ensureAgentV4ConnectionHandshake(
    client.services.zcodeAgentService,
  );
  await client.refreshWorkspaces();
  releaseWorkspaceServices = bindCodeWorkspaceServices(client);
  const workspace = config.workspacePath
    ? await client.openWorkspace(
        config.workspacePath,
        client.projectForPath(config.workspacePath)?.projectId,
      )
    : undefined;
  root.render(
    <CodeHost
      {...(workspace ? { workspace } : {})}
      user={null}
      clientMode={hello.clientMode}
    />,
  );
} catch (error) {
  console.error("Code 工作台启动失败", error);
  root.render(
    <RootStartupLoading
      label={error instanceof Error ? error.message : "Code 工作台启动失败"}
      busy={false}
    />,
  );
}
window.addEventListener(
  "pagehide",
  () => {
    releaseWorkspaceServices?.();
    client.setViewerContextResolver(null);
    client.dispose();
  },
  { once: true },
);
