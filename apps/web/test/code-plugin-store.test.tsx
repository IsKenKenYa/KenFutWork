import {
  zcodePluginsListResultSchema,
  zcodePluginsOverviewResultSchema,
} from "@kenfutwork/shared";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { PluginStorePage } from "@zui/settings/PluginStorePage";
import { StoreProvider } from "@zui/store/StoreProvider";
import { TabStoreProvider } from "@zui/store/TabStoreProvider";
import { afterEach, expect, it, vi } from "vitest";
import { zcodePluginsDescribeResultSchema } from "../../../packages/zcode-shared/dist/index.js";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

let client: CodeHttpChannelClient | null = null;
afterEach(() => {
  cleanup();
  client?.dispose();
  client = null;
  vi.unstubAllGlobals();
});

it("原市场个人目录保留已停用的真实安装卡，显示版本与详情且不误报未安装/孤立", async () => {
  const info = {
    id: "local__probe",
    name: "probe",
    description: "真实库存读面",
    version: "1.2.3",
    enabled: false,
    source: "url",
    marketplace: "kenfutwork-local",
    rootPath: "/packages/probe",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
  };
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call = JSON.parse(String(options?.body));
    if (call.service === "plugin-management")
      return Response.json({
        result:
          call.method === "listPlugins"
            ? { plugins: [info], diagnostics: [] }
            : {
                marketplaces: [
                  {
                    id: "kenfutwork-local",
                    name: "本机插件",
                    source: { type: "local", path: "/packages" },
                    pluginCount: 1,
                  },
                ],
                availablePlugins: [],
                installedPlugins: [
                  {
                    id: info.id,
                    name: info.name,
                    marketplace: info.marketplace,
                    version: info.version,
                    enabled: false,
                    scope: "user",
                  },
                ],
                restorableBuiltins: [],
                diagnostics: [],
                capability: { supported: true },
              },
      });
    if (call.service === "client-config")
      return Response.json({ result: { pluginStoreOrder: null } });
    return Response.json(
      { error: { message: "能力尚未接通" } },
      { status: 501 },
    );
  });
  client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={client.services.broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <PluginStorePage
                  workspacePath="/code"
                  onManageInstalled={() => {}}
                />
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await userEvent.click(
    await screen.findByTestId("plugin-store-segment-personal"),
  );
  expect(await screen.findByText("Probe", { exact: true })).not.toBeNull();
  expect(screen.queryByRole("button", { name: "安装" })).toBeNull();
  await userEvent.click(screen.getByText("Probe", { exact: true }));
  expect(await screen.findByText("1.2.3", { exact: true })).not.toBeNull();
  expect(screen.queryByText(/来源已移除/)).toBeNull();
});

type PluginRpcCall = {
  connectionId: string;
  service: string;
  method: string;
  args: Array<Record<string, unknown>>;
};
type PluginDescription = ReturnType<
  typeof zcodePluginsDescribeResultSchema.parse
>;

/** 仅替换外部 HTTP/SSE：原 Page → DetailView、store 与 ServiceProxy 均真实运行。 */
async function renderPluginDetailsFixture(input: {
  workspacePath: string;
  list: ReturnType<typeof zcodePluginsListResultSchema.parse>;
  overview: ReturnType<typeof zcodePluginsOverviewResultSchema.parse>;
  describe?: () => Promise<PluginDescription>;
  resource?: string;
}) {
  const calls: PluginRpcCall[] = [];
  const workspaceIdentity = JSON.stringify([
    "c5000000-0000-4000-8000-000000000001",
    input.workspacePath,
  ]);
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (input.resource && url.endsWith(input.resource))
      return new Response("<svg/>", {
        headers: { "content-type": "image/svg+xml" },
      });
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call: PluginRpcCall = JSON.parse(String(options?.body));
    calls.push(call);
    if (call.service === "plugin-management") {
      if (call.method === "listPlugins")
        return Response.json({ result: input.list });
      if (call.method === "getPluginsOverview")
        return Response.json({ result: input.overview });
      if (call.method === "describePlugin" && input.describe)
        return Response.json({ result: await input.describe() });
    }
    if (call.service === "client-config")
      return Response.json({ result: { pluginStoreOrder: null } });
    return Response.json(
      { error: { message: "当前只读详情场景未提供该操作。" } },
      { status: 501 },
    );
  });
  client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={client.services.broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <PluginStorePage
                  workspacePath={input.workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  onManageInstalled={() => {}}
                />
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await userEvent.click(
    await screen.findByTestId("plugin-store-segment-personal"),
  );
  return { calls, workspaceIdentity };
}

function pluginDetailsOverview(name: string, installed: boolean) {
  return zcodePluginsOverviewResultSchema.parse({
    marketplaces: [
      {
        id: "detail-fixture-marketplace",
        name: "详情契约来源",
        source: { type: "local", path: "/packages/detail-fixture" },
        pluginCount: 1,
      },
    ],
    availablePlugins: [
      {
        id: `local__${name}`,
        name,
        marketplace: "detail-fixture-marketplace",
        installed,
      },
    ],
    installedPlugins: installed
      ? [
          {
            id: `local__${name}`,
            name,
            marketplace: "detail-fixture-marketplace",
            version: "1.2.3",
            enabled: false,
            scope: "user",
          },
        ]
      : [],
    restorableBuiltins: [],
    diagnostics: [],
    capability: { supported: true },
  });
}

it("原已安装详情消费list的权威组件，停用仍保留名称描述和真实数量，不describe或把Read/Edit冒充MCP", async () => {
  const list = zcodePluginsListResultSchema.parse({
    plugins: [
      {
        id: "local__inspector",
        name: "inspector",
        version: "1.2.3",
        author: "Package Author",
        enabled: false,
        source: "url",
        marketplace: "detail-fixture-marketplace",
        rootPath: "/packages/inspector",
        skillRootCount: 1,
        commandRootCount: 0,
        mcpServerNames: [],
        components: [
          { kind: "mcp", items: [] },
          {
            kind: "skill",
            items: [
              {
                name: "inspect-project",
                description: "读取项目结构并提出检查结论。",
              },
              { name: "review-project", description: "审阅项目的已有变更。" },
            ],
          },
          { kind: "command", items: [] },
        ],
      },
    ],
    diagnostics: [],
  });
  const { calls, workspaceIdentity } = await renderPluginDetailsFixture({
    workspacePath: "/installed-plugin-details",
    list,
    overview: pluginDetailsOverview("inspector", true),
  });
  await userEvent.click(await screen.findByText("Inspector", { exact: true }));
  const detail = await screen.findByTestId("plugin-store-detail");
  const sections = within(detail).getAllByTestId(
    "plugin-store-component-section",
  );
  expect(sections.map((section) => section.dataset.componentKind)).toEqual([
    "skill",
  ]);
  const skillSection = sections.find(
    (section) => section.dataset.componentKind === "skill",
  );
  if (!skillSection) throw new Error("已安装技能分区没有渲染。");
  expect(within(skillSection).getByText("2", { exact: true })).not.toBeNull();
  expect(
    within(detail).getByText("inspect-project", { exact: true }),
  ).not.toBeNull();
  expect(
    within(detail).getByText("读取项目结构并提出检查结论。", { exact: true }),
  ).not.toBeNull();
  expect(
    within(detail).getByText("review-project", { exact: true }),
  ).not.toBeNull();
  expect(
    within(detail).getByText("Package Author", { exact: true }),
  ).not.toBeNull();
  expect(within(detail).getByText("1.2.3", { exact: true })).not.toBeNull();
  expect(screen.queryByText("Read", { exact: true })).toBeNull();
  expect(screen.queryByText("Edit", { exact: true })).toBeNull();
  expect(
    within(detail).queryByTestId("plugin-store-components-loading"),
  ).toBeNull();
  const menuTrigger = within(detail).getByTestId("plugin-store-item-menu");
  menuTrigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(
    await screen.findByTestId("plugin-store-menu-uninstall"),
  ).not.toBeNull();
  // 原市场只传安装/卸载/更新动作；启停动作由独立已安装管理页承接。
  expect(screen.queryByTestId("plugin-store-menu-enabled")).toBeNull();
  expect(calls.filter((call) => call.method === "describePlugin")).toEqual([]);
  expect(
    calls
      .filter((call) => call.service === "plugin-management")
      .map((call) => [call.method, call.args]),
  ).toEqual([
    [
      "listPlugins",
      [
        {
          workspacePath: "/installed-plugin-details",
          workspaceIdentity,
          configScope: "user",
        },
      ],
    ],
    [
      "getPluginsOverview",
      [
        {
          workspacePath: "/installed-plugin-details",
          workspaceIdentity,
          configScope: "user",
        },
      ],
    ],
  ]);
});

it("原候选详情才按名称与来源describe，加载失败可重试，成功显示组件与manifest元信息且仍未安装", async () => {
  let completeFirstRead: ((result: PluginDescription) => void) | undefined;
  const firstRead = new Promise<PluginDescription>((resolve) => {
    completeFirstRead = resolve;
  });
  let reads = 0;
  const description = zcodePluginsDescribeResultSchema.parse({
    components: [
      {
        kind: "skill",
        items: [
          { name: "inspect-project", description: "来自未安装包的检查技能。" },
        ],
      },
    ],
    metadata: { author: "Candidate Author", version: "2.4.0" },
    diagnostics: [],
  });
  const { calls, workspaceIdentity } = await renderPluginDetailsFixture({
    workspacePath: "/candidate-plugin-details",
    list: zcodePluginsListResultSchema.parse({ plugins: [], diagnostics: [] }),
    overview: pluginDetailsOverview("candidate", false),
    describe: async () => (++reads === 1 ? firstRead : description),
  });
  expect(calls.filter((call) => call.method === "describePlugin")).toEqual([]);
  await userEvent.click(await screen.findByText("Candidate", { exact: true }));
  expect(
    await screen.findByTestId("plugin-store-components-loading"),
  ).not.toBeNull();
  if (!completeFirstRead) throw new Error("候选详情请求没有建立。");
  completeFirstRead(
    zcodePluginsDescribeResultSchema.parse({
      components: [],
      diagnostics: [
        {
          code: "package_read_failed",
          severity: "error",
          message: "真实包内容尚不可读。",
        },
      ],
    }),
  );
  expect(
    await screen.findByTestId("plugin-store-components-error"),
  ).not.toBeNull();
  await userEvent.click(screen.getByTestId("plugin-store-components-retry"));
  expect(
    await screen.findByText("来自未安装包的检查技能。", { exact: true }),
  ).not.toBeNull();
  const detail = screen.getByTestId("plugin-store-detail");
  expect(
    within(detail).getByText("Candidate Author", { exact: true }),
  ).not.toBeNull();
  expect(within(detail).getByText("2.4.0", { exact: true })).not.toBeNull();
  expect(within(detail).getByTestId("plugin-store-install")).not.toBeNull();
  expect(
    within(detail).queryByTestId("plugin-store-components-error"),
  ).toBeNull();
  expect(
    within(detail)
      .getAllByTestId("plugin-store-component-section")
      .map((section) => section.dataset.componentKind),
  ).toEqual(["skill"]);
  await waitFor(() =>
    expect(
      calls
        .filter((call) => call.method === "describePlugin")
        .map((call) => call.args),
    ).toEqual([
      [
        {
          workspacePath: "/candidate-plugin-details",
          workspaceIdentity,
          pluginName: "candidate",
          marketplace: "detail-fixture-marketplace",
        },
      ],
      [
        {
          workspacePath: "/candidate-plugin-details",
          workspaceIdentity,
          pluginName: "candidate",
          marketplace: "detail-fixture-marketplace",
        },
      ],
    ]),
  );
  expect(
    calls.some((call) =>
      ["installPlugin", "setPluginEnabled", "uninstallPlugin"].includes(
        call.method,
      ),
    ),
  ).toBe(false);
});

it("原公开市场展示随发行的官方插件，本机分段不重复列出", async () => {
  await renderPluginDetailsFixture({
    workspacePath: "/official-fixture",
    list: zcodePluginsListResultSchema.parse({ plugins: [], diagnostics: [] }),
    overview: zcodePluginsOverviewResultSchema.parse({
      marketplaces: [
        {
          id: "kenfutwork-bundled",
          name: "KenFutWork 官方插件",
          source: { type: "builtin" },
          pluginCount: 1,
        },
      ],
      availablePlugins: [
        {
          id: "builtin__mihome",
          name: "kenfutwork-mihome",
          marketplace: "kenfutwork-bundled",
          installed: false,
          version: "1.0.0",
          listing: { displayName: "米家" },
        },
      ],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
      capability: { supported: true },
    }),
  });
  expect(screen.getByTestId("plugin-store-segment-personal").textContent).toBe(
    "本机",
  );
  expect(screen.queryByText("米家", { exact: true })).toBeNull();
  await userEvent.click(screen.getByTestId("plugin-store-segment-public"));
  expect(await screen.findByText("米家", { exact: true })).not.toBeNull();
  expect(screen.getByText("官方", { exact: true })).not.toBeNull();
});

it("停用的本机包仍显示安装记录中的真实图标及名称", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(
        () => "blob:https://host.example/local-icon",
      );
      static revokeObjectURL = vi.fn();
    },
  );
  const id = "local__native-icon";
  const resource = `/api/plugins/${id}/assets/icon.svg`;
  const info = {
    id,
    name: "native-icon",
    marketplace: "kenfutwork-local",
    version: "1.0.0",
    enabled: false,
    source: "url",
    rootPath: "/packages/native-icon",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
  };
  await renderPluginDetailsFixture({
    workspacePath: "/local-icon-fixture",
    resource,
    list: zcodePluginsListResultSchema.parse({
      plugins: [info],
      diagnostics: [],
    }),
    overview: zcodePluginsOverviewResultSchema.parse({
      marketplaces: [
        {
          id: "kenfutwork-local",
          name: "本机插件",
          source: { type: "local", path: "/packages" },
          pluginCount: 1,
        },
      ],
      availablePlugins: [],
      installedPlugins: [
        {
          id,
          name: info.name,
          marketplace: info.marketplace,
          version: "1.0.0",
          enabled: false,
          scope: "user",
          listing: { displayName: "本机图标", icon: resource },
        },
      ],
      restorableBuiltins: [],
      diagnostics: [],
      capability: { supported: true },
    }),
  });
  await screen.findByText("本机图标", { exact: true });
  await waitFor(() =>
    expect(
      document.querySelector('img[src="blob:https://host.example/local-icon"]'),
    ).not.toBeNull(),
  );
});
