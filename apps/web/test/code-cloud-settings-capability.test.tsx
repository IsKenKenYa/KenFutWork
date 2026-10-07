import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatErrorBanner } from "@zui/ChatErrorBanner";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { CodingPlanUpgradeDialogProvider } from "@zui/settings/CodingPlanUpgradeDialogProvider";
import { ModelProviderSection } from "@zui/settings/ModelProviderSection";
import { StoreProvider } from "@zui/store/StoreProvider";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("原设置与无模型提示按 BYOK 能力保留供应商/配置操作，隐藏云账户套餐且不查询凭据或权益", async () => {
  const calls: Array<{ service: string; method: string }> = [];
  const config = {
    group: "standard-personal",
    access: { type: "api-key" },
    api: {
      type: "openai-chat-completions",
      baseUrl: "https://example.invalid/v1",
    },
  };
  const view = {
    revision: 1,
    providerTemplates: [],
    providerOrder: ["private"],
    providers: [
      {
        providerId: "private",
        providerName: "私有供应商",
        enabled: true,
        executable: true,
        credentialConfigured: true,
        effectiveConfig: config,
        personalConfig: config,
        models: [],
        issues: [],
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, options) => {
      if (String(_input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      const call = JSON.parse(options.body);
      calls.push(call);
      if (call.service === "providerSettingsService")
        return new Response(JSON.stringify({ result: view }));
      if (call.service === "setting")
        return new Response(JSON.stringify({ result: {} }));
      return new Response(JSON.stringify({ result: null }));
    }),
  );
  const client = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  await client.connect();
  const openSettings = vi.fn();
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform(client)}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <StoreProvider broadcastService={client.services.broadcastService}>
            <TooltipProvider>
              <CodingPlanUpgradeDialogProvider>
                <ModelProviderSection workspacePath="/fixture" />
                <ChatErrorBanner
                  error={{
                    code: "MODEL_CONFIG_MISSING",
                    message: "Model config is missing",
                  }}
                  onOpenModelSettings={openSettings}
                />
              </CodingPlanUpgradeDialogProvider>
            </TooltipProvider>
          </StoreProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  try {
    await screen.findByRole("button", { name: "私有供应商" });
    expect(
      screen.queryAllByRole("button", {
        name: /Z\.ai|BigModel|Start Plan|连接 Z/,
      }),
    ).toEqual([]);
    expect(
      screen.queryAllByRole("button", { name: /套餐|开通|购买|升级/ }),
    ).toEqual([]);
    expect(screen.queryByText(/开通编程套餐|正在查询套餐/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(openSettings).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === "refresh")).toBe(true),
    );
    expect(
      calls.filter((call) =>
        /credential|oauth|subscription|payment|usage-stats/i.test(call.service),
      ),
    ).toEqual([]);
  } finally {
    client.dispose();
  }
});

it("未声明宿主能力时原错误横幅仍保持原套餐入口与操作语义", async () => {
  const upgrade = vi.fn();
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <ChatErrorBanner
          error={{
            code: "MODEL_CONFIG_MISSING",
            message: "Model config is missing",
          }}
          onOpenUpgrade={upgrade}
        />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
  expect(screen.getByText(/开通编程套餐/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /开通|升级|套餐/ }));
  expect(upgrade).toHaveBeenCalledOnce();
});
