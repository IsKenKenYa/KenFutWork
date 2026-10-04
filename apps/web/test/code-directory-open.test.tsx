import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DirectoryBrowser } from "@zui/DirectoryBrowser";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";
import { codeHostNotificationResponse } from "./setup/code-host-http";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("原选择器等待真实Project绑定，失败保留目录与重试，Human metadata不派生Task或Canvas", async () => {
  let complete!: (response: Response) => void;
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input, options) => {
    if (String(input).endsWith("/events")) return codeHostNotificationResponse(options?.signal);
    const call = JSON.parse(options.body); calls.push(call);
    if (call.service === "system") return Response.json({ result: { homedir: "/目录", platform: "darwin" } });
    if (call.service === "file") return Response.json({ result: [] });
    return new Promise<Response>((resolve) => { complete = resolve; });
  }));
  const client = new CodeHttpChannelClient({ apiBase: "https://host.example" });
  await client.connect();
  const platform = createCodePlatform(client);
  const opened = vi.fn();
  render(<ZCodeIntlProvider initialLocale="zh-CN"><DirectoryBrowser services={client.directoryServices()} onCancel={() => {}} onSelect={async (path) => { await platform.activateOrSetWorkspace(path); opened(path); }} /></ZCodeIntlProvider>);
  try {
    const select = await screen.findByRole("button", { name: "选择此目录" });
    await screen.findByRole("button", { name: ".." });
    await userEvent.click(select);
    await waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(select.hasAttribute("disabled")).toBe(true);
    expect(opened).not.toHaveBeenCalled();
    complete(Response.json({ error: { message: "目录项目已归档" } }, { status: 409 }));
    await screen.findByText(/目录项目已归档/);
    expect(select.hasAttribute("disabled")).toBe(false);
    await userEvent.click(select);
    await waitFor(() => expect(calls.filter((call) => call.service === "workspace")).toHaveLength(2));
    complete(Response.json({ result: { projectId: "actual-project", name: "目录", path: "/目录", additionalDirectories: [] } }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith("/目录"));
    expect(calls.filter((call) => call.service === "file").every((call) => JSON.stringify(call.args).includes("directory-picker"))).toBe(true);
    expect(calls.filter((call) => call.service === "workspace").map((call) => call.args)).toEqual([[{ path: "/目录" }], [{ path: "/目录" }]]);
    expect(JSON.stringify(calls)).not.toMatch(/canvasId|taskId/);
  } finally { client.dispose(); }
});
