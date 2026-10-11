import type {
  CodeUiWorkspace,
  InstanceContext,
  VoiceSettings,
} from "@kenfutwork/shared";
import type { UserInfo } from "@zcode/shared";
import type { HelloMessage } from "@zcode/shared/zcode-protocol-v4";
import { ScopedErrorBoundary } from "@zui/ErrorBoundary.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider.js";
import { Root } from "@zui/Root.js";
import { RootStartupLoading } from "@zui/root/RootStartupLoading.js";
import {
  applyTheme,
  isTheme,
  normalizeThemePreference,
  type Theme,
} from "@zui/useTheme.js";
import { ensureAgentV4ConnectionHandshake } from "@zui/v4/agentV4ConnectionHandshake.js";
import {
  CodeVoiceProvider,
  type CodeVoiceTransport,
} from "@zui/voice/binding.js";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { CuaSnapshotReader } from "./cuaScreenshotSectionAdapter.js";
import {
  createMacDesktopChrome,
  installDesktopTitlebarDrag,
} from "./desktopChrome.js";
import {
  type CodeHostConfig,
  CodeHttpChannelClient,
} from "./httpChannelClient.js";
import { renderManagementDocument } from "./managementDocument.js";
import { requestManagementOpen } from "./managementNavigation.js";
import { requestParentBootstrap } from "./parentBridge.js";
import { createCodePlatform } from "./platform.js";
import { setSurfaceApiBase } from "./surfaceApi.js";
import { createHostWorkbenchNavigation } from "./workbenchNavigation.js";
import { installHostWorkspaceActivity } from "./workspaceActivity.js";
import { createCodeWorkspaceContextResolver } from "./workspaceServiceController.js";
import { bindCodeWorkspaceServices } from "./workspaceServices.js";
import "@zui/styles.css";
import "./workbenchNavigation.css";

const params = new URLSearchParams(window.location.search);
const releaseActivity = installHostWorkspaceActivity(window.parent);
const releaseTitlebarDrag = installDesktopTitlebarDrag(document);
const desktopChrome = createMacDesktopChrome();
const bootstrap =
  window.parent !== window ? await requestParentBootstrap(window.parent) : null;
const workspacePath = params.get("workspace");
const config: CodeHostConfig = {
  apiBase: bootstrap?.apiBase ?? params.get("api") ?? window.location.origin,
  ...(bootstrap?.accessToken ? { accessToken: bootstrap.accessToken } : {}),
  ...(workspacePath ? { workspacePath } : {}),
};
const client = new CodeHttpChannelClient(config);
// 壳内嵌面（Design/Flow 主区视图）的服务端访问缝：与 client 同一 apiBase/cookie 口径。
setSurfaceApiBase(config.apiBase);
const readCuaSnapshot = client.readCuaSnapshot.bind(client);
/** 语音 transport：转写走 multipart、播报走二进制，改写/设置读走 JSON 通道（cookie 认证同 Code 宿主）。 */
const voiceTransport: CodeVoiceTransport = {
  transcribe: (wav) => client.transcribeVoice(wav),
  speak: (input) => client.speakVoice(input),
  refine: async (input) => {
    const result = await client.request<{ prompt: string }>(
      "/api/voice/refine",
      input,
    );
    return result.prompt;
  },
  fetchSettings: async () => {
    const result = await client.request<{ settings: VoiceSettings }>(
      "/api/voice/settings",
    );
    return result.settings;
  },
};
const workbenchNavigation = bootstrap?.workbenchModes
  ? createHostWorkbenchNavigation(window.parent, bootstrap.workbenchModes)
  : undefined;
const platform = createCodePlatform(client, {
  ...(bootstrap?.managementAvailable
    ? { onOpenManagement: requestManagementOpen }
    : {}),
  ...(workbenchNavigation ? { workbenchNavigation } : {}),
});
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
            isMacDesktop={Boolean(desktopChrome)}
            directoryServices={client.directoryServices()}
            onWorkspaceContextChange={onWorkspaceContextChange}
            initialUserInfo={user}
            {...(workspace ? { initialWorkspaceAbsPath: workspace.path } : {})}
            {...(workspaceIdentity
              ? { initialWorkspaceIdentity: workspaceIdentity }
              : {})}
            workbenchGroupClientMode={clientMode}
            onInterfaceModeChange={(mode) => {
              // 融合后 Design 是壳内主区视图（不再换壳导航）；独立打开（无父窗口）时无处可切，保持 coding。
              if (mode === "office") workbenchNavigation?.open("design");
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
  if (params.get("document") === "management") {
    releaseWorkspaceServices = bindCodeWorkspaceServices(client);
    renderManagementDocument(
      root,
      client,
      bootstrap?.management ?? { page: "settings" },
      () => {
        window.parent.postMessage(
          { type: "kenfutwork:management-close" },
          window.location.origin,
        );
      },
    );
  } else {
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
      <CodeVoiceProvider transport={voiceTransport}>
        <CodeHost
          {...(workspace ? { workspace } : {})}
          // 父窗口 bootstrap 带来的本地实例主人（免账户形态下的当前用户），
          // 侧栏底部据此显示用户而不是「连接使用」。
          user={bootstrap?.user ?? null}
          clientMode={hello.clientMode}
        />
      </CodeVoiceProvider>,
    );
  }
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
    releaseActivity();
    releaseTitlebarDrag();
    workbenchNavigation?.dispose();
    releaseWorkspaceServices?.();
    client.setViewerContextResolver(null);
    client.dispose();
  },
  { once: true },
);

// 外观主题桥（宿主侧）：设置 → 外观（next-themes，默认跟随系统）解析出的 zai 主题
// 经 postMessage 推过来，这里落到 Code UI 的主题系统（localStorage + applyTheme）。
// 没有这座桥，外观切深色时 Code 工作台仍是浅色。内嵌场景（无父窗口）保持 zcode 自有默认。
if (window.parent !== window && bootstrap) {
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      event.origin !== window.location.origin
    )
      return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type !== "kenfutwork:code-theme") return;
    const theme = (event.data as { theme?: unknown }).theme;
    if (typeof theme !== "string" || !isTheme(theme)) return;
    localStorage.setItem("zcode-theme", normalizeThemePreference(theme));
    applyTheme(normalizeThemePreference(theme));
  });
}
