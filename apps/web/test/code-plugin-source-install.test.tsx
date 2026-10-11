import {
  compatReportSchema,
  pluginBundleManifestSchema,
  pluginInstallResponseSchema,
} from "@kenfutwork/shared";
import {
  act,
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
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

let client: CodeHttpChannelClient | undefined;
afterEach(() => {
  cleanup();
  client?.dispose();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openSourceMarket(
  scenario: {
    unknownInstall?: boolean;
    incompatible?: boolean;
    installResponse?: Promise<Response>;
  } = {},
) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const manifest = pluginBundleManifestSchema.parse({
    name: "source-ui",
    title: "来源插件",
    version: "1.0.0",
    format: "kenfutwork",
  });
  const report = compatReportSchema.parse({
    compatible: !scenario.incompatible,
    format: "kenfutwork",
    name: "source-ui",
    version: "1.0.0",
    requiredCapabilities: [],
    supportedCapabilities: [],
    unsupportedCapabilities: [],
    checkedAt: "2026-10-10T00:00:00Z",
    issues: scenario.incompatible
      ? [
          {
            code: "lifecycle_script_present",
            severity: "blocker",
            message: "安装脚本未获授权",
          },
        ]
      : [],
  });
  let installed = false;
  const info = {
    id: "local__source-ui",
    name: "source-ui",
    description: "来源插件",
    version: "1.0.0",
    enabled: true,
    source: "url",
    marketplace: "kenfutwork-local",
    rootPath: "/packages/source-ui",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    listing: { displayName: "来源插件" },
  };
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call = JSON.parse(String(options?.body));
    calls.push(call);
    if (call.service === "plugin-management") {
      if (call.method === "inspectPluginSource")
        return Response.json({ result: { manifest, report } });
      if (call.method === "installPluginFromSource") {
        installed = true;
        if (scenario.installResponse) return scenario.installResponse;
        if (scenario.unknownInstall) throw new TypeError("安装响应丢失");
        return Response.json({
          result: pluginInstallResponseSchema.parse({
            installed: {
              id: info.id,
              name: info.name,
              version: info.version,
              enabled: true,
              source: "url",
              installedAt: "2026-10-10T00:00:00Z",
              manifest,
              report,
            },
            report,
          }),
        });
      }
      return Response.json({
        result:
          call.method === "listPlugins"
            ? { plugins: installed ? [info] : [], diagnostics: [] }
            : {
                marketplaces: [],
                availablePlugins: [],
                installedPlugins: installed
                  ? [
                      {
                        id: info.id,
                        name: info.name,
                        marketplace: "kenfutwork-local",
                        version: info.version,
                        enabled: true,
                        scope: "user",
                        listing: info.listing,
                      },
                    ]
                  : [],
                restorableBuiltins: [],
                diagnostics: [],
                capability: { supported: true },
              },
      });
    }
    if (call.service === "client-config")
      return Response.json({ result: { pluginStoreOrder: null } });
    return Response.json({ result: null });
  });
  client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  const page = (host: CodeHttpChannelClient) => (
    <ServiceProvider services={host.services}>
      <PlatformProvider platform={createCodePlatform(host)}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={host.services.broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <PluginStorePage onManageInstalled={() => {}} />
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>
  );
  const view = render(page(client));
  return {
    calls,
    changeHost: (host: CodeHttpChannelClient) => view.rerender(page(host)),
  };
}

it("无Project原市场保留来源安装菜单及原输入对话框，市场源管理明确未接入且零写入", async () => {
  const { calls } = await openSourceMarket();
  await waitFor(() =>
    expect(calls.some((call) => call.method === "getPluginsOverview")).toBe(
      true,
    ),
  );
  await userEvent.click(screen.getByTestId("plugin-store-create"));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "从链接或目录安装" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "安装插件" }),
  ).not.toBeNull();
  const source = screen.getByRole("textbox", { name: "链接或目录" });
  await userEvent.type(source, "/本机/插件😀");
  expect(
    screen.getByRole("button", { name: "安装" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByTestId("plugin-store-sources-open"));
  expect(
    within(await screen.findByTestId("plugin-store-sources-dialog")).getByText(
      "未接入",
    ),
  ).not.toBeNull();
  expect(
    calls.filter((call) =>
      /addPluginMarketplace|updatePluginMarketplace|installPluginFromSource/.test(
        call.method,
      ),
    ),
  ).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByTestId("plugin-store-sources-dialog")).toBeNull(),
  );
});

it("来源安装响应丢失后保留原表单，只读回真实安装态且不重写", async () => {
  const { calls } = await openSourceMarket({ unknownInstall: true });
  await waitFor(() =>
    expect(calls.some((call) => call.method === "getPluginsOverview")).toBe(
      true,
    ),
  );
  screen.getByTestId("plugin-store-create").focus();
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "从链接或目录安装" }),
  );
  const input = await screen.findByRole("textbox", { name: "链接或目录" });
  await userEvent.type(input, "/本机/插件😀");
  await userEvent.click(screen.getByRole("button", { name: "检查" }));
  await screen.findByText("兼容", { exact: false });
  await userEvent.click(screen.getByRole("button", { name: "安装" }));
  await screen.findByText("安装响应丢失");
  expect(screen.getByRole("dialog", { name: "安装插件" })).not.toBeNull();
  expect((input as HTMLInputElement).value).toBe("/本机/插件😀");
  expect(
    calls.filter((call) => call.method === "installPluginFromSource"),
  ).toMatchObject([
    { args: [{ url: "/本机/插件😀", allowLifecycleScripts: false }] },
  ]);
  const index = calls.findIndex(
    (call) => call.method === "installPluginFromSource",
  );
  expect(
    calls.slice(index + 1).some((call) => call.method === "getPluginsOverview"),
  ).toBe(true);
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByTestId("plugin-store-segment-personal"));
  const card = await screen.findByTestId("plugin-store-card");
  expect(card.textContent).toContain("来源插件");
  expect(card.getAttribute("data-plugin-id")).toBe("local__source-ui");
});

it("来源安装在飞时关闭原表单，完成后仍读回安装态且不改写新表单", async () => {
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { calls } = await openSourceMarket({ installResponse: response });
  await waitFor(() =>
    expect(calls.some((call) => call.method === "getPluginsOverview")).toBe(
      true,
    ),
  );
  screen.getByTestId("plugin-store-create").focus();
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "从链接或目录安装" }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "链接或目录" }),
    "/source-a",
  );
  await userEvent.click(screen.getByRole("button", { name: "检查" }));
  await screen.findByText("兼容", { exact: false });
  await userEvent.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() =>
    expect(
      calls.some((call) => call.method === "installPluginFromSource"),
    ).toBe(true),
  );
  await userEvent.keyboard("{Escape}");
  screen.getByTestId("plugin-store-create").focus();
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "从链接或目录安装" }),
  );
  const nextInput = screen.getByRole("textbox", { name: "链接或目录" });
  await userEvent.clear(nextInput);
  await userEvent.type(nextInput, "/source-b");
  const before = calls.length;
  finish(Response.json({ result: {} }));
  await waitFor(() =>
    expect(
      calls.slice(before).some((call) => call.method === "getPluginsOverview"),
    ).toBe(true),
  );
  expect((nextInput as HTMLInputElement).value).toBe("/source-b");
  expect(screen.getByRole("dialog", { name: "安装插件" })).not.toBeNull();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByTestId("plugin-store-segment-personal"));
  expect(
    (await screen.findByTestId("plugin-store-card")).getAttribute(
      "data-plugin-id",
    ),
  ).toBe("local__source-ui");
  expect(
    calls.filter((call) => call.method === "installPluginFromSource"),
  ).toHaveLength(1);
});

it("A来源安装迟到不能作废B宿主正在读取的真实库存", async () => {
  let finish!: (value: Response) => void;
  const installResponse = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { calls, changeHost } = await openSourceMarket({ installResponse });
  await waitFor(() =>
    expect(calls.some((call) => call.method === "getPluginsOverview")).toBe(
      true,
    ),
  );
  screen.getByTestId("plugin-store-create").focus();
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "从链接或目录安装" }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "链接或目录" }),
    "/source-a",
  );
  await userEvent.click(screen.getByRole("button", { name: "检查" }));
  await screen.findByText("兼容", { exact: false });
  await userEvent.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() =>
    expect(
      calls.some((call) => call.method === "installPluginFromSource"),
    ).toBe(true),
  );
  let readB!: (value: Response) => void;
  const pendingB = new Promise<Response>((resolve) => {
    readB = resolve;
  });
  const bCalls: Array<{ method: string }> = [];
  const info = {
    id: "local__b",
    name: "b-host",
    description: "B库存",
    version: "2.0.0",
    enabled: true,
    source: "url",
    marketplace: "kenfutwork-local",
    rootPath: "/b",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    listing: { displayName: "B库存" },
  };
  vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
    if (url.endsWith("/events"))
      return codeHostNotificationResponse(options?.signal ?? undefined);
    const call = JSON.parse(String(options?.body));
    bCalls.push(call);
    if (call.service === "client-config")
      return Response.json({ result: { pluginStoreOrder: null } });
    if (call.method === "getPluginsOverview") return pendingB;
    if (call.method === "listPlugins")
      return Response.json({ result: { plugins: [info], diagnostics: [] } });
    return Response.json({ result: null });
  });
  const second = new CodeHttpChannelClient({ apiBase: "https://b.example" });
  try {
    await second.connect();
    changeHost(second);
    await waitFor(() =>
      expect(bCalls.some((call) => call.method === "getPluginsOverview")).toBe(
        true,
      ),
    );
    await act(async () => {
      finish(Response.json({ result: {} }));
    });
    await act(async () => {
      readB(
        Response.json({
          result: {
            marketplaces: [],
            availablePlugins: [],
            installedPlugins: [
              {
                id: info.id,
                name: info.name,
                marketplace: info.marketplace,
                version: info.version,
                enabled: true,
                scope: "user",
                listing: info.listing,
              },
            ],
            restorableBuiltins: [],
            diagnostics: [],
            capability: { supported: true },
          },
        }),
      );
    });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("plugin-store-segment-personal"));
    expect(
      (await screen.findByTestId("plugin-store-card")).getAttribute(
        "data-plugin-id",
      ),
    ).toBe("local__b");
    expect(screen.queryByText("来源插件")).toBeNull();
  } finally {
    second.dispose();
  }
});

it("原市场顶栏刷新明确读取库存，未接入的市场源更新零请求", async () => {
  const { calls } = await openSourceMarket();
  await waitFor(() =>
    expect(calls.some((call) => call.method === "getPluginsOverview")).toBe(
      true,
    ),
  );
  const before = calls.length;
  await userEvent.click(
    await screen.findByRole("button", { name: "刷新库存" }),
  );
  await waitFor(() =>
    expect(
      calls.slice(before).some((call) => call.method === "getPluginsOverview"),
    ).toBe(true),
  );
  expect(
    calls.filter((call) => call.method === "updatePluginMarketplace"),
  ).toEqual([]);
});

it("原来源表单显示真实不兼容报告，点击和Enter均不能提交安装", async () => {
  const { calls } = await openSourceMarket({ incompatible: true });
  await waitFor(() =>
    expect(calls.some((call) => call.method === "getPluginsOverview")).toBe(
      true,
    ),
  );
  screen.getByTestId("plugin-store-create").focus();
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "从链接或目录安装" }),
  );
  const input = screen.getByRole("textbox", { name: "链接或目录" });
  await userEvent.type(input, "/blocked");
  await userEvent.click(screen.getByRole("button", { name: "检查" }));
  await screen.findByText("安装脚本未获授权");
  expect(
    screen.getByRole("button", { name: "安装" }).hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "安装" }));
  input.focus();
  await userEvent.keyboard("{Enter}");
  expect(
    calls.filter((call) => call.method === "installPluginFromSource"),
  ).toEqual([]);
  expect(screen.getByRole("dialog", { name: "安装插件" })).not.toBeNull();
  await userEvent.keyboard("{Escape}");
});
