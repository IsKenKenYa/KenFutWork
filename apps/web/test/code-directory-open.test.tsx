import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectoryBrowser } from "@zui/DirectoryBrowser";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("原选择器等待目录绑定，失败显示原错误并保持可重试，成功才通知宿主关闭", async () => {
  let rejectOpen = true;
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, options) => {
      if (String(input).endsWith("/events"))
        return codeHostNotificationResponse(options?.signal);
      const call = JSON.parse(options.body);
      calls.push(call);
      if (call.service === "system")
        return Response.json({ result: { homedir: "/目录" } });
      if (call.service === "file") return Response.json({ result: [] });
      if (rejectOpen)
        return Response.json(
          { error: { message: "目录项目已归档" } },
          { status: 409 },
        );
      return Response.json({
        result: { projectId: "project", canvasId: "canvas", path: "/目录" },
      });
    }),
  );
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  const platform = createCodePlatform(client);
  const opened = vi.fn();
  render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <DirectoryBrowser
        services={client.services}
        onCancel={() => {}}
        onSelect={async (path) => {
          await platform.activateOrSetWorkspace(path);
          opened(path);
        }}
      />
    </ZCodeIntlProvider>,
  );
  try {
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await screen.findByRole("button", { name: ".." });
    await userEvent.click(select);
    await screen.findByText(/目录项目已归档/);
    expect(opened).not.toHaveBeenCalled();
    expect(select.hasAttribute("disabled")).toBe(false);
    rejectOpen = false;
    await userEvent.click(select);
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith("/目录"));
    expect(calls.filter((call) => call.service === "workspace")).toEqual([
      {
        connectionId: "test-host",
        service: "workspace",
        method: "open",
        args: [{ path: "/目录" }],
      },
      {
        connectionId: "test-host",
        service: "workspace",
        method: "open",
        args: [{ path: "/目录" }],
      },
    ]);
  } finally {
    client.dispose();
  }
});
