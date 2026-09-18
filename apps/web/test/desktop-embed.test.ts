// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  boundsOf,
  embedBounds,
  embedClose,
  embedDevtools,
  embedOpen,
  embedVisible,
  isDesktopShell,
} from "../src/lib/desktop-embed";

/**
 * 桌面形态的**真内核浏览器嵌入**桥（路线 2）。
 *
 * 这里锁两件事：① 形态判定（Web 形态必须全部 no-op，不能因为缺 Tauri 全局就抛）；
 * ② 发给 Rust 的命令名与参数形状（`browser_embed_*`，边界是逻辑像素的四个数）——
 * Rust 侧的函数名一旦对不上，前端只会在桌面形态下静默失效。
 */
describe("desktop-embed（桌面壳桥）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI__");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  /** 装上 Tauri 全局并返回可断言的 invoke（参数形状由用例自己声明，避免元组推断成空）。 */
  const installTauri = () => {
    const invoke = vi.fn(
      async (_command: string, _args?: Record<string, unknown>) => undefined,
    );
    Reflect.set(window, "__TAURI__", { core: { invoke } });
    return invoke;
  };

  it("Web 形态：isDesktopShell 为 false，且各动作都是 no-op（不抛）", async () => {
    expect(isDesktopShell()).toBe(false);
    await expect(
      embedOpen("https://example.com", { x: 0, y: 0, width: 10, height: 10 }),
    ).resolves.toBeUndefined();
    await expect(embedDevtools()).resolves.toBeUndefined();
    await expect(embedClose()).resolves.toBeUndefined();
  });

  it("桌面形态：判定为 true，并按 Rust 的命令名与参数调用", async () => {
    const invoke = installTauri();
    expect(isDesktopShell()).toBe(true);

    const bounds = { x: 12, y: 34, width: 560, height: 300 };
    await embedOpen("https://example.com", bounds);
    await embedBounds(bounds);
    await embedVisible(false);
    await embedDevtools();
    await embedClose();

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "browser_embed_open",
      "browser_embed_bounds",
      "browser_embed_visible",
      "browser_embed_devtools",
      "browser_embed_close",
    ]);
    expect(invoke.mock.calls[0]?.[1]).toEqual({
      url: "https://example.com",
      bounds,
    });
    expect(invoke.mock.calls[1]?.[1]).toEqual({ bounds });
    expect(invoke.mock.calls[2]?.[1]).toEqual({ visible: false });
  });

  it("边界取自占位块的 getBoundingClientRect（四舍五入成逻辑像素）", () => {
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      left: 10.4,
      top: 20.6,
      width: 300.5,
      height: 199.4,
      right: 310.9,
      bottom: 220,
      x: 10.4,
      y: 20.6,
      toJSON: () => ({}),
    } as DOMRect);
    expect(boundsOf(element)).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 199,
    });
  });
});
