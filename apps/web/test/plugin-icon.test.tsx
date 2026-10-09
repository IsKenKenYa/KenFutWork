// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginIcon } from "../src/lib/plugin-panels";

/**
 * 插件入口图标加载（回归）。
 *
 * 缺陷：页面与 API 分属两个源（web 3300 / API 3301）后，CSS `mask-image: url()`
 * 的跨源请求默认不带凭据 → 401 → mask 空白，表现为「插件入口的 logo 不见了」
 * （真机 resource timing 实测：`initiatorType: css` → 401，带 credentials 的
 * fetch → 200）。修复：图标先经 `fetch(credentials: "include")` 取回，转同源
 * blob URL 再喂 mask。这里锁三件事：
 * ① 请求必须带 credentials，且命中插件资源路径；
 * ② 成功时 mask 指向 blob URL（同源，mask 可用）；
 * ③ 取不回时落宿主通用图标，不留空白。
 */

const originalCreateObjectURL = URL.createObjectURL;

function stubCreateObjectURL(value: string) {
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => value),
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
      value: originalCreateObjectURL,
      configurable: true,
      writable: true,
    });
  } else {
    // jsdom 未实现：删掉测试注入的桩
    Reflect.deleteProperty(URL, "createObjectURL");
  }
});

describe("插件入口图标", () => {
  it("经带凭据的 fetch 取回后喂 mask（blob URL）", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<svg/>", {
          status: 200,
          headers: { "content-type": "image/svg+xml" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    stubCreateObjectURL("blob:http://localhost:3300/icon-test");

    const { container } = render(
      <PluginIcon icon="assets/icon.svg" pluginId="local__demo" />,
    );

    await vi.waitFor(() => {
      const maskSpan = container.querySelector('span[style*="mask-image"]');
      expect(maskSpan).not.toBeNull();
      expect(maskSpan?.getAttribute("style")).toContain(
        "blob:http://localhost:3300/icon-test",
      );
    });
    // 跨源直引不带凭据会 401——必须走 credentials: include
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/plugins/local__demo/assets/icon.svg"),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("取不回时落宿主通用图标，不留空白", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );

    // 换独立 pluginId：模块级图标缓存按 URL 缓存，避免命中上一例的成功结果
    const { container } = render(
      <PluginIcon icon="assets/icon.svg" pluginId="local__demo-fail" />,
    );

    await vi.waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
  });
});
