import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { useModelProviders } from "@zui/hooks/useModelProviders";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { resolveModelProviderConnectivityWorkspacePath } from "@zui/lib/modelProviderConnectivityTarget";
import {
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@zui/settings/PluginScopeMenu";
import { PluginsSection } from "@zui/settings/PluginsSection";
import { TabStoreProvider, useTabStoreApi } from "@zui/store/TabStoreProvider";
import type { WorkspaceTabState } from "@zui/store/tabStore";
import { type PropsWithChildren, useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalLocalWorkspaceIdentity } from "../../../packages/zcode-shared/dist/index.js";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import { codeHostNotificationResponse } from "./setup/code-host-http";

const projectId = "c5000000-0000-4000-8000-000000000001";
function localTab(
  workspacePath = "/code",
): WorkspaceTabState & { workspaceIdentity: string } {
  return {
    id: "local-project",
    kind: "workspace",
    label: "本机项目",
    workspacePath,
    workspaceIdentity: canonicalLocalWorkspaceIdentity(
      projectId,
      workspacePath,
    ),
  };
}

let client: CodeHttpChannelClient | undefined;
let releaseServices: (() => void) | undefined;
afterEach(() => {
  cleanup();
  releaseServices?.();
  releaseServices = undefined;
  client?.dispose();
  client = undefined;
  vi.unstubAllGlobals();
});

it.each(["/code", "C:\\code", "\\\\server\\share\\code"])(
  "带Project身份的本机目录 %s 可测试模型并进入插件作用域，保留身份键",
  (path) => {
    const tab = localTab(path);
    expect(
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tab.workspaceIdentity,
        activeWorkspaceTab: tab,
        workspaceTabs: [tab],
      }),
    ).toBe(path);
    expect(isPluginScopeWorkspaceConnected(tab)).toBe(true);
    expect(getPluginWorkspaceKey(tab)).toBe(tab.workspaceIdentity);
  },
);

it.each([
  { workspaceIdentity: "remote:project" },
  { workspaceIdentity: "[broken" },
  { workspaceIdentity: canonicalLocalWorkspaceIdentity(projectId, "/other") },
  { remoteSessionId: "remote-session" },
  { remoteTarget: { kind: "cloud", workspaceId: "remote" } },
])("远端或不匹配目标 %j 不交给本机探测，回退到真实本机Project", (override) => {
  const active = { ...localTab("/remote"), ...override };
  const local = localTab();
  expect(
    resolveModelProviderConnectivityWorkspacePath({
      activeWorkspacePath: active.workspacePath,
      activeWorkspaceIdentity: active.workspaceIdentity,
      activeWorkspaceTab: active,
      workspaceTabs: [active],
    }),
  ).toBe("");
  expect(
    resolveModelProviderConnectivityWorkspacePath({
      activeWorkspacePath: active.workspacePath,
      activeWorkspaceIdentity: active.workspaceIdentity,
      activeWorkspaceTab: active,
      workspaceTabs: [active, local],
    }),
  ).toBe(local.workspacePath);
});

it("显式远端会话继续要求连接；缺失的本机目录继续禁止插件管理", () => {
  const tab = localTab();
  expect(
    isPluginScopeWorkspaceConnected({
      ...tab,
      workspaceIdentity: "remote:project",
    }),
  ).toBe(false);
  expect(
    isPluginScopeWorkspaceConnected({ ...tab, remoteSessionId: "session" }),
  ).toBe(true);
  expect(
    isPluginScopeWorkspaceConnected({
      ...tab,
      availability: "unavailable-local-directory",
    }),
  ).toBe(false);
  expect(
    resolveModelProviderConnectivityWorkspacePath({
      activeWorkspaceTab: {
        ...tab,
        remoteSessionId: "session",
        localWorkspacePath: "/remembered",
      },
      workspaceTabs: [],
    }),
  ).toBe("/remembered");
});

type Target = Parameters<typeof useModelProviders>[0];
type RpcCall = { service: string; method: string; args: unknown[] };
async function renderConnectivity(target: Target) {
  const calls: RpcCall[] = [];
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call: RpcCall = JSON.parse(String(options?.body));
    calls.push(call);
    if (call.service === "providerSettingsService") {
      return Response.json({
        result:
          call.method === "testModelConnectivity"
            ? { success: true }
            : {
                revision: 1,
                providers: [],
                providerTemplates: [],
                providerOrder: [],
              },
      });
    }
    return Response.json({ result: {} });
  });
  const channel = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  client = channel;
  await channel.connect();
  const hook = renderHook(() => useModelProviders(target), {
    wrapper: ({ children }: PropsWithChildren) => (
      <ServiceProvider services={channel.services}>{children}</ServiceProvider>
    ),
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { hook, calls };
}

it("本机Project模型测试通过原Hook发出真实RPC，不因identity非空在客户端被拦截", async () => {
  const tab = localTab();
  const { hook, calls } = await renderConnectivity(tab);
  expect(
    await hook.result.current.testModelConnectivity("glm", "glm-model"),
  ).toEqual({ success: true });
  expect(
    calls.filter((call) => call.method === "testModelConnectivity"),
  ).toMatchObject([
    {
      service: "providerSettingsService",
      method: "testModelConnectivity",
      args: [
        { workspacePath: "/code", providerId: "glm", modelId: "glm-model" },
      ],
    },
  ]);
});

it.each([
  { ...localTab(), workspaceIdentity: "remote:project" },
  {
    ...localTab(),
    workspaceIdentity: canonicalLocalWorkspaceIdentity(projectId, "/other"),
  },
  { ...localTab(), connectivityWorkspaceRequired: true },
])("未获得本机cwd的目标继续显示原因且不发模型RPC：%j", async (target) => {
  const { hook, calls } = await renderConnectivity({
    ...target,
    connectivityUnavailableMessage: "请先打开本机目录",
  });
  expect(
    await hook.result.current.testModelConnectivity("glm", "model"),
  ).toEqual({
    success: false,
    error: { message: "请先打开本机目录" },
  });
  expect(
    calls.filter((call) => call.method === "testModelConnectivity"),
  ).toEqual([]);
});

it("远端激活时明确提供的本机探测cwd通过原RPC，不使用远端目录", async () => {
  const { hook, calls } = await renderConnectivity({
    workspacePath: "/remote",
    workspaceIdentity: "remote:project",
    connectivityWorkspacePath: "/local",
    connectivityWorkspaceRequired: true,
  });
  expect(
    await hook.result.current.testModelConnectivity("glm", "model"),
  ).toEqual({ success: true });
  expect(
    calls.find((call) => call.method === "testModelConnectivity")?.args,
  ).toEqual([{ workspacePath: "/local", providerId: "glm", modelId: "model" }]);
});

function OpenLocalProject({ children }: PropsWithChildren) {
  const store = useTabStoreApi();
  useLayoutEffect(() => {
    const tab = localTab();
    store.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeWorkspacePath: tab.workspacePath,
      activeWorkspaceIdentity: tab.workspaceIdentity,
    });
  }, [store]);
  return children;
}

it("原插件管理页接受已绑定的本机Project，读取真实库存RPC并展示已安装插件", async () => {
  const tab = localTab();
  const calls: RpcCall[] = [];
  const plugin = {
    id: "local__probe",
    name: "probe",
    version: "1.2.3",
    enabled: true,
    source: "url",
    marketplace: "local",
    rootPath: "/packages/probe",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
  };
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call: RpcCall = JSON.parse(String(options?.body));
    calls.push(call);
    if (call.service === "plugin-management")
      return Response.json({
        result:
          call.method === "listPlugins"
            ? { plugins: [plugin], diagnostics: [] }
            : {
                marketplaces: [
                  {
                    id: "local",
                    name: "本机插件",
                    source: { type: "local", path: "/packages" },
                    pluginCount: 1,
                  },
                ],
                availablePlugins: [],
                installedPlugins: [
                  {
                    id: plugin.id,
                    name: plugin.name,
                    marketplace: "local",
                    version: "1.2.3",
                    enabled: true,
                    scope: "user",
                  },
                ],
                restorableBuiltins: [],
                diagnostics: [],
                capability: { supported: true },
              },
      });
    if (call.service === "mcp-configuration")
      return Response.json({ result: { servers: [], disabledServers: [] } });
    if (call.service === "skills")
      return Response.json({
        result: {
          skills: [],
          diagnostics: [],
          capability: { userScopeAvailable: true },
        },
      });
    return Response.json({ result: {} });
  });
  const channel = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  client = channel;
  await channel.connect();
  channel.registerWorkspaces([
    {
      projectId,
      path: tab.workspacePath,
      name: tab.label,
      additionalDirectories: [],
    },
  ]);
  releaseServices = bindCodeWorkspaceServices(channel);
  render(
    <ServiceProvider services={channel.services}>
      <PlatformProvider platform={createCodePlatform(channel)}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <TabStoreProvider>
            <OpenLocalProject>
              <TooltipProvider>
                <PluginsSection
                  workspacePath={tab.workspacePath}
                  workspaceIdentity={tab.workspaceIdentity}
                  onOpenPluginStore={() => {}}
                />
              </TooltipProvider>
            </OpenLocalProject>
          </TabStoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  expect(await screen.findByText("Probe", { exact: true })).not.toBeNull();
  expect(screen.queryByText("请先打开工作区")).toBeNull();
  expect(calls.filter((call) => call.method === "listPlugins")).toMatchObject([
    {
      service: "plugin-management",
      args: [
        {
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
          configScope: "user",
        },
      ],
    },
  ]);
});
