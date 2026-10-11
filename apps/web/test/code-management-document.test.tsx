import type { ManagementTarget } from "@kenfutwork/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { Root as CodeRoot } from "@zui/Root";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { renderManagementDocument } from "../src/components/workbench/zcode/host/managementDocument";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { bindCodeWorkspaceServices } from "../src/components/workbench/zcode/host/workspaceServices";
import {
  installCodeRootBrowser,
  restoreCodeRootBrowser,
} from "./setup/code-root-host-browser";
import {
  createCodeRootHostFetch,
  rootProjectId,
  rootWorkspace,
} from "./setup/code-root-host-http";

let root: Root | undefined,
  client: CodeHttpChannelClient | undefined,
  release: (() => void) | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  release?.();
  client?.dispose();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  restoreCodeRootBrowser();
});

async function openManager(target: ManagementTarget, installed = false) {
  installCodeRootBrowser();
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const requests: string[] = [];
  const fallback = createCodeRootHostFetch(calls, { rejectOpen: false });
  const plugin = {
    id: "local__probe",
    name: "probe",
    version: "1.0.0",
    enabled: true,
    source: "url",
    marketplace: "local",
    rootPath: "/packages/probe",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url.endsWith("/rpc")) {
      const call = JSON.parse(String(init?.body));
      if (call.service === "mcp-sync") {
        calls.push(call);
        return Response.json({
          result:
            call.method === "loadMcpFromUserDirectory"
              ? { servers: [] }
              : { statuses: {} },
        });
      }
      if (call.service === "plugin-management") {
        calls.push(call);
        return Response.json({
          result:
            call.method === "listPlugins"
              ? { plugins: installed ? [plugin] : [], diagnostics: [] }
              : {
                  marketplaces: installed
                    ? [
                        {
                          id: "local",
                          name: "本机",
                          source: { type: "local", path: "/packages" },
                          pluginCount: 1,
                        },
                      ]
                    : [],
                  availablePlugins: [],
                  installedPlugins: installed
                    ? [
                        {
                          id: plugin.id,
                          name: plugin.name,
                          marketplace: "local",
                          version: plugin.version,
                          enabled: true,
                          scope: "user",
                        },
                      ]
                    : [],
                  restorableBuiltins: [],
                  diagnostics: [],
                  capability: { supported: true },
                },
        });
      }
      if (call.service === "skills") {
        calls.push(call);
        return Response.json({
          result: {
            skills: [],
            diagnostics: [],
            capability: {
              userScopeAvailable: true,
              workspaceScopeAvailable: false,
            },
          },
        });
      }
    }
    return fallback(url, init);
  });
  const host = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  client = host;
  await host.connect();
  release = bindCodeWorkspaceServices(host);
  const container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  const close = vi.fn();
  await act(async () => {
    renderManagementDocument(mounted, host, target, close);
  });
  return { calls, requests, close };
}

it("原管理文档无Project打开MCP并使用原返回按钮，无隐式Task或工作区创建", async () => {
  const { calls, requests, close } = await openManager({
    page: "settings",
    section: "mcp",
  });
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.service === "mcp-sync" && c.method === "loadMcpFromUserDirectory",
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByTestId("settings-back-button"));
  expect(close).toHaveBeenCalledOnce();
  expect(
    calls.filter(
      (c) =>
        c.service === "workspace" ||
        c.service === "zcode-task" ||
        c.method === "ensureConversationWorkspace",
    ),
  ).toEqual([]);
  expect(requests.filter((url) => url.endsWith("/workspaces"))).toEqual([]);
});

it("原技能管理页使用真实本机目录接口，无Project也能读取安装态", async () => {
  const { calls, requests } = await openManager({
    page: "settings",
    section: "skill",
  });
  await waitFor(() =>
    expect(
      calls.some((c) => c.service === "skills" && c.method === "list"),
    ).toBe(true),
  );
  expect(requests.filter((url) => url.endsWith("/workspaces"))).toEqual([]);
  expect(
    calls.filter(
      (c) =>
        c.service === "workspace" ||
        c.service === "zcode-task" ||
        c.method === "ensureConversationWorkspace",
    ),
  ).toEqual([]);
});

it("原市场独立文档无需工作区，返回关闭文档且不创建Task", async () => {
  const { calls, close } = await openManager({ page: "plugins" });
  await screen.findByTestId("plugin-store-root");
  fireEvent.click(
    screen.getByRole("button", { name: /返回工作区|Back to workspace/ }),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(
    calls.filter(
      (c) =>
        c.service === "workspace" ||
        c.service === "zcode-task" ||
        c.method === "ensureConversationWorkspace",
    ),
  ).toEqual([]);
});

it("原已安装插件管理页无Project也读取本机安装库存", async () => {
  const { calls } = await openManager({ page: "settings", section: "plugin" });
  await waitFor(() =>
    expect(
      calls.some(
        (c) => c.service === "plugin-management" && c.method === "listPlugins",
      ),
    ).toBe(true),
  );
  expect(
    calls.filter(
      (c) =>
        c.service === "workspace" ||
        c.service === "zcode-task" ||
        c.method === "ensureConversationWorkspace",
    ),
  ).toEqual([]);
});

it("本机插件目录无匹配搜索时保留原空态，不成为白板", async () => {
  await openManager({ page: "settings", section: "plugin" });
  const query = await screen.findByPlaceholderText(/搜索插件|Search plugins/);
  fireEvent.change(query, { target: { value: "不存在的插件" } });
  await screen.findByText(
    /当前范围尚未安装插件|No plugins are installed in this scope/,
  );
});

it("原设置的浏览市场操作在同一文档导航，不关闭共用管理文档", async () => {
  const { close } = await openManager({ page: "settings", section: "plugin" });
  fireEvent.click(await screen.findByTestId("plugin-store-browse"));
  await screen.findByTestId("plugin-store-root");
  expect(close).not.toHaveBeenCalled();
});

it("原市场进入已安装管理后原返回按钮回市场，再关闭才返回工作区", async () => {
  const { close } = await openManager({ page: "plugins" }, true);
  fireEvent.click(
    await screen.findByRole("button", { name: /管理已安装|Manage installed/ }),
  );
  await screen.findByTestId("settings-page");
  fireEvent.click(screen.getByTestId("settings-back-button"));
  expect(close).not.toHaveBeenCalled();
  await screen.findByTestId("plugin-store-root");
  fireEvent.click(
    screen.getByRole("button", { name: /返回工作区|Back to workspace/ }),
  );
  expect(close).toHaveBeenCalledOnce();
});

it("独立实例设置不提供改变工作区模式的重复配置", async () => {
  await openManager({ page: "settings", section: "general" });
  expect(
    screen.queryByRole("combobox", { name: /界面模式|interface mode/i }),
  ).toBeNull();
});

it("原Code侧栏的技能与MCP操作交给共用宿主文档，主工作区不切入本地设置tab", async () => {
  const { calls } = await openManager({ page: "settings", section: "mcp" });
  if (!client || !root) throw new Error("宿主未初始化");
  client.registerWorkspaces([rootWorkspace]);
  const open = vi.fn();
  const platform = createCodePlatform(client, { onOpenManagement: open });
  const host = client,
    mounted = root;
  await act(async () =>
    mounted.render(
      <ZCodeIntlProvider initialLocale="zh-CN">
        <CodeRoot
          services={host.services}
          platform={platform}
          initialWorkspaceAbsPath="/code"
          initialWorkspaceIdentity={JSON.stringify([rootProjectId, "/code"])}
          restoreSession={false}
          allowRemoteWorkspace={false}
        />
      </ZCodeIntlProvider>,
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: /^技能$/ }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: "settings", section: "skill" }),
  );
  expect(screen.queryByTestId("settings-page")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /^MCP 服务器$/ }));
  expect(open).toHaveBeenLastCalledWith(
    expect.objectContaining({ page: "settings", section: "mcp" }),
  );
  expect(calls.filter((c) => c.method === "createTask")).toEqual([]);
});
