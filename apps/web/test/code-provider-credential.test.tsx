import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { useModelProviders } from "@zui/hooks/useModelProviders";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { ServiceProvider } from "@zui/hooks/useServices";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import type { ProviderSettingsFormProvider } from "@zui/lib/providerSettingsFormTypes";
import { InlineEditableProviderCard } from "@zui/settings/model-provider-section/InlineEditableProviderCard";
import { ProviderDetailFeedbackBoundary } from "@zui/settings/model-provider-section/ProviderDetailFeedback";
import { useCallback } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function OriginalProviderCard() {
  const operation = useModelProviders({ workspacePath: "/fixture" });
  const save = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await operation.saveProvider(provider);
    },
    [operation.saveProvider],
  );
  const provider = operation.modelProviders[0];
  return provider ? (
    <InlineEditableProviderCard provider={provider} onSave={save} />
  ) : null;
}

function renderOriginalCard(beforeSave: () => Promise<void> = async () => {}) {
  const provider = {
    providerId: "provider-1",
    providerName: "原供应商",
    enabled: true,
    executable: true,
    credentialConfigured: true,
    effectiveConfig: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: {
        type: "openai-chat-completions",
        baseUrl: "https://example.invalid/v1",
      },
    },
    personalConfig: {
      group: "standard-personal",
      access: { type: "api-key" },
      api: {
        type: "openai-chat-completions",
        baseUrl: "https://example.invalid/v1",
      },
    },
    issues: [],
    models: [],
  };
  const serverView = {
    revision: 1,
    providerTemplates: [],
    providerOrder: ["provider-1"],
    providers: [provider],
  };
  const savedKeys: Array<string | null | undefined> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, options) => {
      if (String(_input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      const request = JSON.parse(options.body);
      if (request.service === "providerSettingsService") {
        if (request.method === "savePersonalProviderOverlay") {
          const key = request.args[1].access?.apiKey;
          savedKeys.push(key);
          await beforeSave();
          if (key !== undefined) provider.credentialConfigured = key !== null;
          provider.executable = provider.credentialConfigured;
          serverView.revision += 1;
        }
        // 外部 HTTP 边界仅返回 presence，绝不返回 Key。
        return new Response(JSON.stringify({ result: serverView }));
      }
      return new Response(JSON.stringify({ result: {} }));
    }),
  );
  const client = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
  });
  render(
    <ServiceProvider services={client.services}>
      <PlatformProvider platform={createCodePlatform()}>
        <ZCodeIntlProvider initialLocale="zh-CN">
          <TooltipProvider>
            <ProviderDetailFeedbackBoundary>
              <OriginalProviderCard />
            </ProviderDetailFeedbackBoundary>
          </TooltipProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
  return { client, savedKeys };
}

it("原供应商卡片只显示真实凭证 presence，替换后清本次草稿，明确清除发送 null", async () => {
  const { client, savedKeys } = renderOriginalCard();
  try {
    const input = await screen.findByTestId("model-provider-api-key-input");
    expect(input).toHaveProperty("value", "");
    expect(
      screen.getByRole("button", { name: "清除已保存的 API Key" }),
    ).toHaveProperty("disabled", false);
    await userEvent.type(input, "replacement-private-key");
    await userEvent.tab();
    await waitFor(() => expect(savedKeys).toContain("replacement-private-key"));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    await userEvent.click(
      screen.getByRole("button", { name: "清除已保存的 API Key" }),
    );
    await waitFor(() => expect(savedKeys.at(-1)).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "清除已保存的 API Key" }),
      ).toBeNull(),
    );
    expect(input).toHaveProperty("value", "");
  } finally {
    client.dispose();
  }
});

it("原供应商的迟到保存成功不能清掉继续输入的新 Key，新草稿仅在自己的应答后清除", async () => {
  const pending: Array<() => void> = [];
  const { client, savedKeys } = renderOriginalCard(
    () => new Promise<void>((resolve) => pending.push(resolve)),
  );
  try {
    const input = await screen.findByTestId("model-provider-api-key-input");
    await userEvent.type(input, "first-private-key");
    await userEvent.tab();
    await waitFor(() => expect(savedKeys[0]).toBe("first-private-key"));
    await userEvent.click(input);
    await userEvent.clear(input);
    await userEvent.type(input, "newer-private-key");
    await act(async () => {
      pending[0]?.();
    });
    expect(input).toHaveProperty("value", "newer-private-key");
    await userEvent.tab();
    await waitFor(() => expect(savedKeys.at(-1)).toBe("newer-private-key"));
    await act(async () => {
      pending.at(-1)?.();
    });
    await waitFor(() => expect(input).toHaveProperty("value", ""));
  } finally {
    for (const resolve of pending) resolve();
    client.dispose();
  }
});

it("原供应商保存失败保留 Key 草稿，原重试操作成功后才清除", async () => {
  let attempt = 0;
  const { client, savedKeys } = renderOriginalCard(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("外部服务暂时失败");
  });
  try {
    const input = await screen.findByTestId("model-provider-api-key-input");
    await userEvent.type(input, "retry-private-key");
    await userEvent.tab();
    await screen.findByRole("alert");
    expect(input).toHaveProperty("value", "retry-private-key");
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    expect(savedKeys).toEqual(["retry-private-key", "retry-private-key"]);
  } finally {
    client.dispose();
  }
});
