// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { pickCanvasProjectDirectory } from "../src/components/workbench/zcode/host/canvasProjectDirectories";
import { createTauriDirectoryPicker } from "../src/components/workbench/zcode/host/directoryPicker";

type TauriHost = Window & {
  __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> };
};

const host = window as TauriHost;

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
});

it("普通浏览器不声明原生目录选择能力", () => {
  expect(createTauriDirectoryPicker()).toBeNull();
});

it("桌面端通过 Tauri dialog/open 返回选中的绝对目录", async () => {
  const invoke = vi.fn(async () => "C:\\work\\project");
  host.__TAURI_INTERNALS__ = { invoke };
  const picker = createTauriDirectoryPicker();

  expect(picker).not.toBeNull();
  await expect(picker?.()).resolves.toBe("C:\\work\\project");
  expect(invoke).toHaveBeenCalledWith("plugin:dialog|open", {
    options: { directory: true, multiple: false, title: "选择文件夹" },
  });
});

it("取消原生目录框返回 null", async () => {
  host.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };

  await expect(createTauriDirectoryPicker()?.()).resolves.toBeNull();
});

it("目录恢复复用 Tauri 通道，不再弹服务端目录框", async () => {
  host.__TAURI_INTERNALS__ = {
    invoke: vi.fn(async () => "C:\\work\\recovery"),
  };
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await expect(pickCanvasProjectDirectory()).resolves.toBe(
    "C:\\work\\recovery",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
