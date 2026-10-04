import { cleanup, render, screen } from "@testing-library/react";
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
