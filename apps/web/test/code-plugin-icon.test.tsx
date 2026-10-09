import { act, cleanup, render, waitFor } from "@testing-library/react";
import { PluginIcon } from "@zui/components/PluginIcon";
import { PlatformProvider } from "@zui/hooks/usePlatform";
import { afterEach, expect, it, vi } from "vitest";
import { CodeHttpChannelClient } from "../src/components/workbench/zcode/host/httpChannelClient";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";

let client: CodeHttpChannelClient | undefined;
afterEach(() => {
  cleanup();
  client?.dispose();
  client = undefined;
  vi.unstubAllGlobals();
});

it("原插件头像通过现有宿主认证读取声明资源，关闭后释放图片引用", async () => {
  const create = vi.fn(() => "blob:http://localhost:3300/plugin-icon");
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const transport = vi.fn(
    async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        headers: { "content-type": "image/svg+xml" },
      }),
  );
  vi.stubGlobal("fetch", transport);
  client = new CodeHttpChannelClient({
    apiBase: "http://localhost:3001",
    accessToken: "fixture-local-access",
  });
  const { container } = render(
    <PlatformProvider platform={createCodePlatform(client)}>
      <PluginIcon
        pluginId="builtin__mihome"
        src="/api/plugins/builtin__mihome/assets/icon.svg"
      />
    </PlatformProvider>,
  );
  await waitFor(() =>
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:http://localhost:3300/plugin-icon",
    ),
  );
  expect(transport).toHaveBeenCalledWith(
    "http://localhost:3001/api/plugins/builtin__mihome/assets/icon.svg",
    expect.objectContaining({
      credentials: "include",
      redirect: "error",
      headers: { authorization: "Bearer fixture-local-access" },
    }),
  );
  expect(create).toHaveBeenCalledTimes(1);
  client.dispose();
  expect(revoke).toHaveBeenCalledWith("blob:http://localhost:3300/plugin-icon");
});

it("图标读取失败保留原通用图标，不向任意URL或跨插件身份发请求", async () => {
  const transport = vi.fn(async () => new Response("missing", { status: 404 }));
  vi.stubGlobal("fetch", transport);
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  const platform = createCodePlatform(client);
  const { container, rerender } = render(
    <PlatformProvider platform={platform}>
      <PluginIcon pluginId="a" src="/api/plugins/b/assets/icon.svg" />
    </PlatformProvider>,
  );
  expect(transport).not.toHaveBeenCalled();
  rerender(
    <PlatformProvider platform={platform}>
      <PluginIcon pluginId="a" src="/api/plugins/a/assets/%2e%2e/private.svg" />
    </PlatformProvider>,
  );
  expect(transport).not.toHaveBeenCalled();
  await act(async () =>
    rerender(
      <PlatformProvider platform={platform}>
        <PluginIcon pluginId="a" src="/api/plugins/a/assets/icon.svg" />
      </PlatformProvider>,
    ),
  );
  expect(transport).toHaveBeenCalledTimes(1);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

it("关闭宿主后迟到的资源不能创建或挂入图片引用", async () => {
  const create = vi.fn(() => "blob:http://localhost:3300/late");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  let finish!: (response: Response) => void;
  const transport = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", transport);
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  const { container } = render(
    <PlatformProvider platform={createCodePlatform(client)}>
      <PluginIcon pluginId="a" src="/api/plugins/a/assets/icon.svg" />
    </PlatformProvider>,
  );
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  client.dispose();
  await act(async () =>
    finish(
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    ),
  );
  expect(create).not.toHaveBeenCalled();
  expect(container.querySelector("img")).toBeNull();
});
