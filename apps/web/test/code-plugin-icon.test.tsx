import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
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
  document.documentElement.classList.remove("dark");
});

it("导航单色图标继承明暗文字色，认证资源复用且市场头像保留原色", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(
        () => "blob:http://localhost:3300/monochrome",
      );
      static revokeObjectURL = vi.fn();
    },
  );
  const transport = vi.fn(
    async () =>
      new Response('<svg fill="black"/>', {
        headers: { "content-type": "image/svg+xml" },
      }),
  );
  vi.stubGlobal("fetch", transport);
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  const platform = createCodePlatform(client);
  const { container } = render(
    <PlatformProvider platform={platform}>
      <PluginIcon
        pluginId="mihome"
        src="/api/plugins/mihome/assets/icon.svg"
        monochrome
      />
      <PluginIcon pluginId="mihome" src="/api/plugins/mihome/assets/icon.svg" />
    </PlatformProvider>,
  );
  const mask = await waitFor(() => {
    const found = container.querySelector<HTMLElement>('[style*="mask-image"]');
    expect(found).not.toBeNull();
    if (!found) throw new Error("导航图标未显示");
    return found;
  });
  expect(mask.style.backgroundColor).toBe("currentcolor");
  expect(mask.style.maskImage).toContain(
    "blob:http://localhost:3300/monochrome",
  );
  document.documentElement.classList.add("dark");
  expect(mask.style.backgroundColor).toBe("currentcolor");
  // 不变量是「宿主认证资源只取一次，两个图标共用」；线稿嗅探另有一次本地 blob 读取，
  // 不打到宿主端点，所以按 URL 计而不是按全局 fetch 计。
  const hostFetches = transport.mock.calls.filter(
    (call) =>
      String((call as unknown[])[0] ?? "").startsWith("http://localhost:3001"),
  );
  expect(hostFetches).toHaveLength(1);
  expect(container.querySelectorAll("img")[1]?.className).toContain(
    "object-contain",
  );
  const decoder = container.querySelector("img");
  if (!decoder) throw new Error("图标解码器未挂载");
  fireEvent.error(decoder);
  expect(container.querySelector('[style*="mask-image"]')).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
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

it("无图标的插件按显示名首字出字母头像，不再清一色 Blocks", () => {
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  const { container } = render(
    <PlatformProvider platform={createCodePlatform(client)}>
      <PluginIcon
        pluginId="cad"
        label="CAD"
        className="size-16"
        iconClassName="size-6"
      />
      <PluginIcon
        pluginId="mihome"
        label="米家"
        className="size-8"
        iconClassName="size-4"
      />
      <PluginIcon pluginId="noop" />
    </PlatformProvider>,
  );
  const glyphs = [...container.querySelectorAll("svg text")].map(
    (node) => node.textContent,
  );
  expect(glyphs).toEqual(["C", "米"]);
  // 没有 label 时保持原兜底图标（Blocks），不猜名字。
  expect(container.querySelectorAll("svg.lucide-blocks")).toHaveLength(1);
});

it("线稿图标（SVG 含 currentColor）自动走 mask，暗色下不再黑底黑字", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(
        () => "blob:http://localhost:3300/lineart",
      );
      static revokeObjectURL = vi.fn();
    },
  );
  // 我们自带插件的 icon.svg 是自绘线稿：stroke="currentColor"
  const transport = vi.fn(
    async () =>
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg"><path stroke="currentColor"/></svg>',
        { headers: { "content-type": "image/svg+xml" } },
      ),
  );
  vi.stubGlobal("fetch", transport);
  client = new CodeHttpChannelClient({ apiBase: "http://localhost:3001" });
  const { container } = render(
    <PlatformProvider platform={createCodePlatform(client)}>
      <PluginIcon
        pluginId="bundled__kenfutwork-ha"
        src="/api/plugins/bundled__kenfutwork-ha/assets/icon.svg"
      />
    </PlatformProvider>,
  );
  // 调用方没传 monochrome：靠资源自身声明（currentColor）判定
  const mask = await waitFor(() => {
    const found = container.querySelector<HTMLElement>(
      '[style*="mask-image"]',
    );
    expect(found).not.toBeNull();
    if (!found) throw new Error("线稿图标未走 mask");
    return found;
  });
  expect(mask.style.backgroundColor).toBe("currentcolor");
  expect(container.querySelector("img")?.className).toContain("opacity-0");
});
