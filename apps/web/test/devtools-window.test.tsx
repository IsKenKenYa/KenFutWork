// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevtoolsWindow } from "../src/components/workbench/devtools-window";
import { withAppProviders } from "./test-providers";

/**
 * 内嵌开发者工具（工作台级悬浮窗：可拖动 / 可关闭 / 不局限于右栏）。
 *
 * 这一层锁**接线与形态**：两个 Tab 各自拿数据（控制台 / 网络）、就地执行表达式、
 * 拖动会真的改位置并记住、关闭走回调；完整 DevTools（Elements/性能/应用）由标题栏的 ↗
 * 去受控浏览器窗口里开——那条路真机验过，这里只锁它被调用。
 */
const {
  fetchConsoleMessagesMock,
  fetchBrowserRequestsMock,
  evaluateInPageMock,
  clearConsoleMessagesMock,
  openCdpDevtoolsMock,
} = vi.hoisted(() => ({
  fetchConsoleMessagesMock: vi.fn(),
  fetchBrowserRequestsMock: vi.fn(),
  evaluateInPageMock: vi.fn(),
  clearConsoleMessagesMock: vi.fn(),
  openCdpDevtoolsMock: vi.fn(),
}));

vi.mock("../src/lib/server-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server-api")>()),
  fetchConsoleMessages: fetchConsoleMessagesMock,
  fetchBrowserRequests: fetchBrowserRequestsMock,
  evaluateInPage: evaluateInPageMock,
  clearConsoleMessages: clearConsoleMessagesMock,
  openCdpDevtools: openCdpDevtoolsMock,
}));

const MESSAGE = {
  seq: 1,
  level: "error" as const,
  text: "ReferenceError: nope",
  at: "2026-09-18T00:00:01.000Z",
  source: "exception" as const,
};

const REQUEST = {
  seq: 1,
  method: "GET",
  url: "https://a.com/boom",
  status: 500,
  at: "2026-09-18T00:00:02.000Z",
};

beforeEach(() => {
  window.localStorage.clear();
  fetchConsoleMessagesMock.mockReset();
  fetchBrowserRequestsMock.mockReset();
  evaluateInPageMock.mockReset();
  clearConsoleMessagesMock.mockReset();
  openCdpDevtoolsMock.mockReset();
  fetchConsoleMessagesMock.mockResolvedValue({
    messages: [MESSAGE],
    nextSeq: 1,
  });
  fetchBrowserRequestsMock.mockResolvedValue({
    requests: [REQUEST],
    nextSeq: 1,
  });
  evaluateInPageMock.mockResolvedValue({
    seq: 2,
    level: "log",
    text: "Example Domain",
    at: "2026-09-18T00:00:03.000Z",
    source: "input",
  });
  clearConsoleMessagesMock.mockResolvedValue(undefined);
  openCdpDevtoolsMock.mockResolvedValue({ windowId: 1 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderWindow(onClose = vi.fn()) {
  render(
    withAppProviders(<DevtoolsWindow accessToken="token" onClose={onClose} />),
  );
  return { onClose };
}

describe("内嵌开发者工具（悬浮窗）", () => {
  it("控制台 Tab：拉到的消息上屏（按级别着色），并能就地执行表达式", async () => {
    const user = userEvent.setup();
    renderWindow();
    expect(await screen.findByText("ReferenceError: nope")).toBeVisible();

    await user.type(
      screen.getByLabelText("执行表达式"),
      "document.title{Enter}",
    );
    await waitFor(() =>
      expect(evaluateInPageMock).toHaveBeenCalledWith(
        "token",
        "document.title",
      ),
    );
    expect(await screen.findByText("Example Domain")).toBeVisible();
  });

  it("网络 Tab：列出请求（方法/状态/URL）", async () => {
    const user = userEvent.setup();
    renderWindow();
    await user.click(screen.getByRole("button", { name: /网络/ }));
    expect(await screen.findByText("https://a.com/boom")).toBeVisible();
    expect(screen.getByText("500")).toBeVisible();
    expect(fetchBrowserRequestsMock).toHaveBeenCalled();
  });

  it("可拖动：标题栏按下 → 移动 → 松手，位置跟着指针走并记下来", async () => {
    renderWindow();
    const dialog = screen.getByRole("dialog", { name: "开发者工具" });
    const initialLeft = Number.parseFloat(dialog.style.left);
    const initialTop = Number.parseFloat(dialog.style.top);
    const handle = screen.getByText("（可拖动）");

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 130 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(Number.parseFloat(dialog.style.left)).toBe(initialLeft + 40);
    expect(Number.parseFloat(dialog.style.top)).toBe(initialTop + 30);
    expect(
      JSON.parse(window.localStorage.getItem("workbench:devtools-pos") ?? "{}"),
    ).toEqual({ x: initialLeft + 40, y: initialTop + 30 });
  });

  it("关闭按钮走回调（窗口由工作台挂载/卸载）", async () => {
    const user = userEvent.setup();
    const { onClose } = renderWindow();
    await user.click(screen.getByRole("button", { name: "关闭开发者工具" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("清空：本地列表清掉并通知服务端", async () => {
    const user = userEvent.setup();
    renderWindow();
    await screen.findByText("ReferenceError: nope");
    await user.click(screen.getByRole("button", { name: "清空" }));
    await waitFor(() =>
      expect(clearConsoleMessagesMock).toHaveBeenCalledWith("token"),
    );
    expect(screen.queryByText("ReferenceError: nope")).not.toBeInTheDocument();
  });

  it("↗：开受控浏览器窗口里的完整 DevTools（Elements / 性能 / 应用）", async () => {
    const user = userEvent.setup();
    renderWindow();
    await user.click(
      screen.getByRole("button", { name: "在浏览器窗口打开完整开发者工具" }),
    );
    await waitFor(() => expect(openCdpDevtoolsMock).toHaveBeenCalled());
    expect(openCdpDevtoolsMock.mock.calls[0]?.[0]).toBe("token");
  });
});
