import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { CodingPlanUpgradeDialogProvider } from "@zui/settings/CodingPlanUpgradeDialogProvider";
import { StoreProvider } from "@zui/store/StoreProvider";
import { WorkspaceSidebarFooter } from "@zui/WorkspaceSidebarFooter";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("BYOK 宿主的原账户菜单保留偏好和统计，隐藏云登录、套餐与购买查询", async () => {
  const requests: Array<{ service: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, options) => {
      if (String(_input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      const call = JSON.parse(options.body);
      requests.push(call);
      // 系统边界替身：设置与个人供应商可读，云服务明确不可用。
      if (call.service === "setting")
        return new Response(JSON.stringify({ result: {} }));
      if (call.service === "providerSettingsService")
        return new Response(
          JSON.stringify({
            result: {
              revision: 0,
              providers: [],
              policy: { allowPersonalProviders: true },
            },
          }),
        );
      return new Response(
        JSON.stringify({ error: { message: "云服务未提供" } }),
        { status: 501 },
      );
    }),
  );
  const client = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  const platform = createCodePlatform(client);
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={client.services.broadcastService}>
            <TooltipProvider>
              <CodingPlanUpgradeDialogProvider>
                <WorkspaceSidebarFooter
                  theme="light"
                  localeMenuValue="zh-CN"
                  onLocaleChange={() => {}}
                  onThemeChange={() => {}}
                  onUsageClick={() => {}}
                  onLogin={() => {}}
                  onLogout={() => {}}
                  user={{
                    id: "owner",
                    username: "local",
                    displayName: "本机用户",
                  }}
                />
              </CodingPlanUpgradeDialogProvider>
            </TooltipProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "本机用户" }));
  expect(screen.getByRole("menuitem", { name: "界面模式" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "使用统计" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: /套餐|登录|退出/ })).toBeNull();
  await waitFor(() =>
    expect(requests.some((call) => call.service === "setting")).toBe(true),
  );
  expect(
    requests.filter((call) =>
      /subscription|credential|payment/i.test(call.service),
    ),
  ).toEqual([]);
  client.dispose();
});
