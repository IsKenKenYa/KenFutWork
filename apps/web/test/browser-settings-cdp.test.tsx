// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserSettingsSection } from "../src/components/workbench/browser-settings-section";

/**
 * 「连接到 Chrome / 断开」与「自动截图」是设置页里**真的有执行面**的三个开关
 * （R5-4 + 本轮 CDP 通道）：连接会真起一个带调试端口的独立浏览器实例、自动截图
 * 会让服务端在每次浏览器动作后落一张图。
 *
 * 这一层锁的是**接线**：状态行读的是服务端真值、按钮点下去真发请求、失败原因原样显示
 * （静默失败是这块的历史教训——先前的「连接到 Chrome」是置灰摆设）。
 */
const fetchCdpStatus = vi.fn();
const connectCdp = vi.fn();
const disconnectCdp = vi.fn();
const fetchPermissionSettings = vi.fn();
const updatePermissionSettings = vi.fn();

vi.mock("../src/lib/server-api.js", () => ({
  fetchCdpStatus: (...args: unknown[]) => fetchCdpStatus(...args),
  connectCdp: (...args: unknown[]) => connectCdp(...args),
  disconnectCdp: (...args: unknown[]) => disconnectCdp(...args),
  fetchPermissionSettings: (...args: unknown[]) =>
    fetchPermissionSettings(...args),
  updatePermissionSettings: (...args: unknown[]) =>
    updatePermissionSettings(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  fetchPermissionSettings.mockResolvedValue({
    browserControlEnabled: false,
    browserAutoScreenshot: false,
    browserHeadless: false,
  });
  fetchCdpStatus.mockResolvedValue({ status: "disconnected" });
  updatePermissionSettings.mockImplementation(
    async (_token, patch: unknown) => ({
      browserControlEnabled: false,
      browserAutoScreenshot: false,
      browserHeadless: false,
      ...(patch as object),
    }),
  );
});

afterEach(() => {
  cleanup();
});

async function renderSection() {
  render(<BrowserSettingsSection accessToken="tok" />);
  await waitFor(() => expect(fetchCdpStatus).toHaveBeenCalled());
  return userEvent.setup();
}

describe("浏览器设置：连接到 Chrome（CDP）", () => {
  it("未连接时显示「未连接」与「连接到 Chrome」，没有「断开」", async () => {
    await renderSection();
    expect(await screen.findByText("状态：未连接")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "连接到 Chrome" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "断开" })).toBeNull();
  });

  it("点「连接到 Chrome」→ 真发请求，成功后状态行与提示都变", async () => {
    connectCdp.mockResolvedValue({ status: "connected", headless: false });
    const user = await renderSection();

    await user.click(screen.getByRole("button", { name: "连接到 Chrome" }));

    expect(connectCdp).toHaveBeenCalledWith("tok");
    expect(await screen.findByText("状态：已连接（有窗口）")).toBeVisible();
    expect(screen.getByText("已连接（独立实例，专用 profile）")).toBeVisible();
    expect(await screen.findByRole("button", { name: "断开" })).toBeVisible();
  });

  it("连接失败：把服务端原因原样显示（不吞成「失败」）", async () => {
    connectCdp.mockRejectedValue(
      new Error("连不上浏览器调试端口 9333（ECONNREFUSED）。"),
    );
    const user = await renderSection();

    await user.click(screen.getByRole("button", { name: "连接到 Chrome" }));

    expect(await screen.findByText(/连不上浏览器调试端口/)).toBeVisible();
  });

  it("已连接时点「断开」→ 状态回到未连接", async () => {
    fetchCdpStatus.mockResolvedValue({ status: "connected", headless: true });
    disconnectCdp.mockResolvedValue({ status: "disconnected" });
    const user = await renderSection();

    expect(await screen.findByText("状态：已连接（无头）")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "断开" }));

    expect(disconnectCdp).toHaveBeenCalledWith("tok");
    expect(await screen.findByText("状态：未连接")).toBeVisible();
  });

  it("「自动截图」写服务端并回读；写失败回滚开关（不留假的打开态）", async () => {
    const user = await renderSection();
    const toggle = await screen.findByRole("switch", { name: "自动截图" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);
    await waitFor(() =>
      expect(updatePermissionSettings).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({ browserAutoScreenshot: true }),
      ),
    );
    expect(await screen.findByText("已开启自动截图")).toBeVisible();
    expect(screen.getByRole("switch", { name: "自动截图" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    updatePermissionSettings.mockRejectedValueOnce(new Error("写入失败"));
    await user.click(screen.getByRole("switch", { name: "自动截图" }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "自动截图" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(await screen.findByText(/写入失败/)).toBeVisible();
  });
});
