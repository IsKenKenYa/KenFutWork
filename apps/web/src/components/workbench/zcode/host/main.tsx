import type { ViewerResponse } from "@kenfutwork/shared";
import type { UserInfo } from "@zcode/shared";
import type { HelloMessage } from "@zcode/shared/zcode-protocol-v4";
import { ScopedErrorBoundary } from "@zui/ErrorBoundary.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { Root } from "@zui/Root.js";
import { RootStartupLoading } from "@zui/root/RootStartupLoading.js";
import { ensureAgentV4ConnectionHandshake } from "@zui/v4/agentV4ConnectionHandshake.js";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  type CodeHostConfig,
  CodeHttpChannelClient,
} from "./httpChannelClient.js";
import { navigateToDesign, requestParentBootstrap } from "./parentBridge.js";
import { createCodePlatform } from "./platform.js";
import { bindCodeWorkspaceServices } from "./workspaceServices.js";
import "@zui/styles.css";

const params = new URLSearchParams(window.location.search);
const bootstrap =
  window.parent !== window ? await requestParentBootstrap(window.parent) : null;
const config: CodeHostConfig = {
  apiBase: bootstrap?.apiBase ?? params.get("api") ?? window.location.origin,
  ...(bootstrap?.accessToken ? { accessToken: bootstrap.accessToken } : {}),
  ...(params.get("workspace")
    ? { workspacePath: params.get("workspace")! }
    : {}),
};
const client = new CodeHttpChannelClient(config);
const platform = createCodePlatform(client);
const element = document.getElementById("root");
if (!element) throw new Error("Code 宿主缺少 root 容器");
const root = createRoot(element);

function CodeHost({
  workspacePath,
  user,
  clientMode,
}: {
  workspacePath?: string;
  user: UserInfo | null;
  clientMode: HelloMessage["clientMode"];
}) {
  const services = useSyncExternalStore(
    client.subscribeServices,
    () => client.services,
  );
  return (
    <ZCodeIntlProvider
      initialLocale="zh-CN"
      settingService={services.settingService}
      broadcastService={services.broadcastService}
    >
      <ScopedErrorBoundary scope="kenfutwork-code-host">
        <Root
          services={services}
          platform={platform}
          initialUserInfo={user}
          {...(workspacePath ? { initialWorkspaceAbsPath: workspacePath } : {})}
          workbenchGroupClientMode={clientMode}
          onInterfaceModeChange={(mode) => {
            if (mode === "office") navigateToDesign();
          }}
          preferDirectoryBrowser
          restoreSession
          allowRemoteWorkspace={false}
          supportsEmbeddedBrowser={false}
          initialWorkspaceLoadingFallback={
            <RootStartupLoading label="打开 Code 工作目录" />
          }
        />
      </ScopedErrorBoundary>
    </ZCodeIntlProvider>
  );
}

root.render(<RootStartupLoading label="加载 Code 工作台" />);
try {
  const user = bootstrap
    ? bootstrap.user
    : await client
        .request<ViewerResponse>("/api/viewer")
        .then(({ profile }) => ({
          id: profile.id,
          username: profile.email,
          displayName: profile.displayName,
        }));
  await client.connect();
  const hello = await ensureAgentV4ConnectionHandshake(
    client.services.zcodeAgentService,
  );
  bindCodeWorkspaceServices(client);
  root.render(
    <CodeHost
      {...(config.workspacePath ? { workspacePath: config.workspacePath } : {})}
      user={user}
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
window.addEventListener("pagehide", () => client.dispose(), { once: true });
