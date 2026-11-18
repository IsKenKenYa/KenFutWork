// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodePlatform } from "../src/components/workbench/zcode/host/platform";

function tauriEnv() {
  const invoke = vi.fn(async () => undefined);
  (window.parent as Window & { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke },
  };
  return invoke;
}

afterEach(() => {
  delete (window.parent as Window & { __TAURI__?: unknown }).__TAURI__;
});

describe("Code 宿主平台的桌面能力接线", () => {
  it("桌面形态清理内置浏览器数据走服务端 CDP 清理端点", async () => {
    tauriEnv();
    const requests: Array<{ path: string; body: unknown }> = [];
    const platform = createCodePlatform({
      request: async (path: string, body?: unknown) => {
        requests.push({ path, body });
        return { cleared: true };
      },
    } as never);

    expect(platform.supportsEmbeddedBrowserDataClear).toBe(true);
    const result = await platform.clearEmbeddedBrowserData?.("cache");
    expect(result).toEqual({ success: true });
    expect(requests).toEqual([
      { path: "/api/browser/cdp/clear-data", body: { mode: "cache" } },
    ]);
    // Chrome 登录数据导入当前形态不支持，入口不应被标为可用。
    expect(platform.supportsChromeBrowserDataImport).not.toBe(true);
  });

  it("快捷键录制态通知桌面壳收掉原生菜单", () => {
    const invoke = tauriEnv();
    const platform = createCodePlatform({
      request: async () => ({}),
    } as never);
    platform.setShortcutRecordingActive?.(true);
    platform.setShortcutRecordingActive?.(false);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, "set_shortcut_recording_active", {
      active: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "set_shortcut_recording_active", {
      active: false,
    });
  });

  it("Web 形态不提供清理入口，保持诚实禁用", async () => {
    const platform = createCodePlatform({
      request: async () => ({}),
    } as never);
    expect(platform.supportsEmbeddedBrowserDataClear).not.toBe(true);
    expect(platform.supportsChromeBrowserDataImport).not.toBe(true);
  });
});
