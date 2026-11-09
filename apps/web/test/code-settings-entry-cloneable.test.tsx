import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { StoreProvider } from "@zui/store/StoreProvider";
import { TabStoreProvider, useTabStore } from "@zui/store/TabStoreProvider";
import { WorkspaceSidebarFooter } from "@zui/WorkspaceSidebarFooter";
import { afterEach, expect, it, vi } from "vitest";
import { TID_TASK_SETTINGS_BUTTON } from "../../../packages/zcode-shared/dist/index.js";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { requestManagementOpen } from "../src/components/workbench/zcode/host/managementNavigation";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

/** 与 WorkspaceSidebar 相同的接线：设置入口直接复用 tab store 的导航动作。 */
function SidebarFooterHarness() {
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  return (
    <WorkspaceSidebarFooter
      theme="light"
      localeMenuValue="zh-CN"
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onSettingsButtonClick={openSettingsTab}
      onUsageClick={openSettingsTab}
      user={{ id: "owner", username: "local", displayName: "本机用户" }}
    />
  );
}

it("侧栏设置入口只发纯数据：点击事件不会混进宿主 postMessage 载荷", async () => {
  sessionStorage.clear();
  const sent: unknown[] = [];
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
    sent.push(message);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, options) => {
      if (String(_input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      return new Response(JSON.stringify({ result: {} }));
    }),
  );
  const client = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  await client.connect();
  const platform = createCodePlatform(client, {
    onOpenManagement: requestManagementOpen,
  });
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={client.services.broadcastService}>
            <TooltipProvider>
              <TabStoreProvider
                onOpenSettings={(target) =>
                  platform.openSettingsDocument?.(target)
                }
              >
                <SidebarFooterHarness />
              </TabStoreProvider>
            </TooltipProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );

  await userEvent.click(await screen.findByTestId(TID_TASK_SETTINGS_BUTTON));

  const opens = sent.filter(
    (message) =>
      (message as { type?: string } | null)?.type ===
      "kenfutwork:open-management",
  );
  expect(opens).toHaveLength(1);
  const payload = opens[0] as { target: unknown };
  // 浏览器里做不到结构化克隆的对象（DOM/Event 实例）会让 postMessage 抛
  // DataCloneError 并静默丢掉整条导航消息；这里等价复验。
  expect(() => structuredClone(payload)).not.toThrow();
  expect(payload.target).toMatchObject({ page: "settings" });
  client.dispose();
});
