import { cleanup, render, screen } from "@testing-library/react";
import { PlatformProvider } from "@zui/hooks/usePlatform.js";
import { CuaAppSummaryIcon } from "@zui/ToolCallBlocks/renderers/cuaAppSummaryIcon.js";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("原应用图标组件经当前宿主通知连接/认证RPC读取图标", async () => {
  const calls: unknown[] = [];
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWAAAAABJRU5ErkJggg==";
  const request = {
    locators: [
      { kind: "darwin-bundle-id" as const, value: "com.apple.finder" },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      expect(options?.credentials).toBe("include");
      expect(options?.headers).toMatchObject({
        authorization: "Bearer fixture-only",
      });
      if (input.endsWith("/events"))
        return codeHostNotificationResponse(options?.signal ?? undefined);
      const body = JSON.parse(String(options?.body));
      calls.push(body);
      return Response.json({ result: { iconDataUrl: dataUrl } });
    }),
  );
  const client = new CodeHttpChannelClient({
    apiBase: "https://host.example",
    accessToken: "fixture-only",
  });
  const platform = createCodePlatform(client);
  try {
    const view = render(
      <PlatformProvider platform={platform}>
        <CuaAppSummaryIcon name="Finder" iconRequest={request} />
      </PlatformProvider>,
    );
    expect(
      (await screen.findByRole("img", { name: "Finder" })).getAttribute("src"),
    ).toBe(dataUrl);
    expect(calls).toEqual([
      {
        connectionId: "test-host",
        service: "platform",
        method: "getApplicationIcon",
        args: [request],
      },
    ]);
    expect(view.container.innerHTML).not.toContain("fixture-only");
  } finally {
    client.dispose();
  }
});
