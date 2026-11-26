import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopWorkbenchTitlebar } from "../src/components/workbench/zcode/host/DesktopWorkbenchTitlebar";
import {
  createMacDesktopChrome,
  installDesktopTitlebarDrag,
} from "../src/components/workbench/zcode/host/desktopChrome";

let release: (() => void) | undefined;
afterEach(() => {
  cleanup();
  release?.();
  vi.unstubAllGlobals();
});

it("原标题栏按钮与红绿灯安全区共行，拖动不吞按钮，全屏恢复原边距并释放原生订阅", async () => {
  let fullscreen = false;
  let resize: (() => void) | undefined;
  const unlisten = vi.fn();
  const native = {
    startDragging: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    isFullscreen: vi.fn(async () => fullscreen),
    onResized: vi.fn(async (handler: () => void) => {
      resize = handler;
      return unlisten;
    }),
  };
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
  });
  vi.stubGlobal("__TAURI__", { window: { getCurrentWindow: () => native } });
  release = installDesktopTitlebarDrag(document);
  const toggle = vi.fn();
  const view = render(
    <DesktopWorkbenchTitlebar isSidebarVisible onToggleSidebar={toggle} />,
  );
  const button = screen.getByRole("button", { name: "切换侧边栏" });
  fireEvent.mouseDown(button, { button: 0 });
  fireEvent.click(button);
  expect(toggle).toHaveBeenCalledOnce();
  expect(native.startDragging).not.toHaveBeenCalled();
  const region = screen.getByTestId("desktop-titlebar-drag-region");
  fireEvent.mouseDown(region, { button: 0 });
  expect(native.startDragging).toHaveBeenCalledOnce();
  fireEvent.doubleClick(region);
  expect(native.toggleMaximize).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      view.container
        .querySelector('[style*="padding-left"]')
        ?.getAttribute("style"),
    ).toContain("96px"),
  );
  await act(async () => {
    fullscreen = true;
    resize?.();
  });
  expect(view.container.querySelector('[style*="padding-left"]')).toBeNull();
  await act(async () => {
    fullscreen = false;
    resize?.();
  });
  expect(
    view.container
      .querySelector('[style*="padding-left"]')
      ?.getAttribute("style"),
  ).toContain("96px");
  const chrome = createMacDesktopChrome();
  await chrome?.setTitleBarTheme("dark");
  await chrome?.setTitleBarTheme("system");
  expect(native.setTheme.mock.calls).toEqual([["dark"], [null]]);
  view.unmount();
  expect(unlisten).toHaveBeenCalledOnce();
  release();
  release = undefined;
  fireEvent.mouseDown(region, { button: 0 });
  expect(native.startDragging).toHaveBeenCalledOnce();
});

it("普通浏览器保留原布局，不渲染原生工具栏或接管页面鼠标", () => {
  vi.stubGlobal("__TAURI__", undefined);
  expect(createMacDesktopChrome()).toBeNull();
  const { container } = render(
    <DesktopWorkbenchTitlebar isSidebarVisible onToggleSidebar={vi.fn()} />,
  );
  expect(container.childElementCount).toBe(0);
});
