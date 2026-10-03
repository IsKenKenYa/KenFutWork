import { appSettingsSchema } from "@kenfutwork/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "@zui/App";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { setPendingSettingsSectionIntent } from "@zui/lib/settingsNavigation";
import { SettingsPage } from "@zui/SettingsPage";
import { CodingPlanUpgradeDialogProvider } from "@zui/settings/CodingPlanUpgradeDialogProvider";
import { StoreProvider } from "@zui/store/StoreProvider";
import { TabStoreProvider } from "@zui/store/TabStoreProvider";
import { CronCreateAutomationCard } from "@zui/ToolCallBlocks/renderers/cron-create";
import { OffPeakCreateTaskCard } from "@zui/ToolCallBlocks/renderers/offpeak-create";
import { V4ComposerCuaEntry } from "@zui/v4/composer/V4ComposerCuaEntry";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

const clients: CodeHttpChannelClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function createHostFixture(originalCapabilities: boolean) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  );
  const calls: Array<{ service: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      if (String(input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      const call = JSON.parse(options.body);
      calls.push(call);
      if (call.service === "setting")
        return Response.json({
          result: appSettingsSchema.parse({
            computerUseComposerEntryHidden: false,
          }),
        });
      if (call.service === "system")
        return Response.json({
          result: { platform: "darwin", homedir: "/fixture" },
        });
      if (call.service === "providerSettingsService")
        return Response.json({
          result: {
            revision: 1,
            providerTemplates: [],
            providers: [],
            providerOrder: [],
          },
        });
      if (call.service === "zcode-task") return Response.json({ result: [] });
      return Response.json(
        { error: { message: "当前宿主没有该服务" } },
        { status: 501 },
      );
    }),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  clients.push(client);
  const platform = createCodePlatform(client);
  if (originalCapabilities) {
    delete platform.supportsAutomations;
    delete platform.supportsEmbeddedBrowser;
    delete platform.supportsComputerUse;
  }
  return { client, platform, calls };
}

function renderOriginalSurfaces(originalCapabilities = false) {
  const { client, platform, calls } = createHostFixture(originalCapabilities);
  const openToolAutomation = vi.fn();
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={client.services.broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <CodingPlanUpgradeDialogProvider>
                  <App
                    services={client.services}
                    baseFeedbackService={client.services.feedbackService}
                    workspaceAbsPath=""
                    isDesktop
                    isMacDesktop
                    {...(platform.supportsEmbeddedBrowser === undefined
                      ? {}
                      : {
                          supportsEmbeddedBrowser:
                            platform.supportsEmbeddedBrowser,
                        })}
                    onCreateTask={() => {}}
                    onCreateConversationTask={() => {}}
                    onOpenWorkspace={() => {}}
                    onOpenFolderFromWorkspaceMenu={() => {}}
                    onCreateScratchWorkspace={async () => null}
                    onConnectRemote={async () => ""}
                    onSelectRemoteProject={async () => {}}
                    onCancelRemoteProject={async () => {}}
                    onReconnectRemoteWorkspace={async () => {}}
                    reconnectingRemoteWorkspaceKeys={[]}
                    remoteWorkspaceErrorByWorkspaceKey={{}}
                  />
                  <SettingsPage isDesktop isMacDesktop />
                  <V4ComposerCuaEntry workspacePath="/fixture" />
                  <CronCreateAutomationCard
                    automation={{
                      automationId: "scheduled",
                      title: "定时任务结果",
                    }}
                    onOpenAutomationsMain={openToolAutomation}
                  />
                  <OffPeakCreateTaskCard
                    task={{ offPeakTaskId: "idle", title: "闲时任务结果" }}
                    onOpenAutomationsMain={openToolAutomation}
                  />
                </CodingPlanUpgradeDialogProvider>
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  return { calls, openToolAutomation };
}

it("未接通的自动化/浏览器/CUA 不出现在原侧栏或设置；隐藏分区跳转保持当前页", async () => {
  const { calls } = renderOriginalSurfaces();
  await screen.findByTestId("settings-section-nav-appearance");
  expect(screen.queryByTestId("automations-open")).toBeNull();
  for (const id of ["automations", "browser", "computerUse"])
    expect(screen.queryByTestId(`settings-section-nav-${id}`)).toBeNull();
  expect(screen.getByText("定时任务结果").textContent).toBe("定时任务结果");
  expect(screen.getByText("闲时任务结果").textContent).toBe("闲时任务结果");
  for (const id of ["cron-create-open", "offpeak-create-open"])
    expect(screen.queryByTestId(id)).toBeNull();
  await userEvent.click(screen.getByTestId("settings-section-nav-appearance"));
  expect(screen.getByTestId("settings-page").dataset.activeSection).toBe(
    "appearance",
  );
  for (const id of ["automations", "browser", "computerUse"] as const) {
    await act(async () => setPendingSettingsSectionIntent(id));
    expect(screen.getByTestId("settings-page").dataset.activeSection).toBe(
      "appearance",
    );
  }
  expect(
    calls.filter((call) =>
      /automation|off.?peak|cua|browser/i.test(call.service),
    ),
  ).toEqual([]);
  expect(calls.filter((call) => call.service === "plugin-management")).toEqual(
    [],
  );
  await userEvent.click(screen.getByTestId("plugin-store-sidebar-open"));
  expect(
    screen
      .getByTestId("plugin-store-sidebar-open")
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("未声明能力的原宿主保留自动化主入口和浏览器设置及原点击语义", async () => {
  const { openToolAutomation } = renderOriginalSurfaces(true);
  await screen.findByTestId("settings-section-nav-appearance");
  expect(screen.getByTestId("settings-section-nav-browser").isConnected).toBe(
    true,
  );
  // 固定原版将自动化放在主视图，CUA 设置分区也默认隐藏。
  for (const id of ["automations", "computerUse"])
    expect(screen.queryByTestId(`settings-section-nav-${id}`)).toBeNull();
  await userEvent.click(screen.getByTestId("automations-open"));
  expect(
    screen.getByTestId("automations-open").getAttribute("aria-pressed"),
  ).toBe("true");
  await userEvent.click(screen.getByTestId("cron-create-open"));
  await userEvent.click(screen.getByTestId("offpeak-create-open"));
  expect(openToolAutomation.mock.calls).toEqual([
    ["scheduled"],
    ["idle", "idle"],
  ]);
});
