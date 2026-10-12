import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
  getSurfaceApiBase: () => "",
}));

const { BrowserPane } = await import(
  "../src/components/workbench/zcode/host/BrowserPane.js"
);

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
});

function connectedApis() {
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/browser/cdp/status") {
      return { status: "connected", currentUrl: "" };
    }
    if (path === "/api/browser/cdp/view") {
      return {
        ticket: "ticket-1",
        viewport: { width: 1280, height: 720, scale: 1 },
      };
    }
    if (path === "/api/browser/cdp/input") {
      return {};
    }
    if (path === "/api/browser/cdp/console") {
      return {};
    }
    throw new Error(`unexpected ${path} ${init?.method ?? ""}`);
  });
}

test("连接→开流→MJPEG 画面渲染；地址栏导航走 view；历史栈前进后退", async () => {
  connectedApis();
  render(<BrowserPane initialUrl="https://example.com" />);
  const img = await screen.findByAltText("浏览器画面");
  await waitFor(() =>
    expect(img.getAttribute("src")).toBe(
      "/api/browser/cdp/stream?ticket=ticket-1",
    ),
  );
  expect(
    surfaceJson,
  ).toHaveBeenCalledWith(
    "/api/browser/cdp/view",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        url: "https://example.com",
        width: 1280,
        height: 720,
      }),
    }),
  );

  // 未连时自动 connect（headless，面板即窗口）
  // （本用例 status 直接 connected，另测未连路径）

  // 地址栏导航：补协议、压栈
  const address = screen.getByLabelText("地址栏");
  await user.clear(address);
  await user.type(address, "another.example.org");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://another.example.org",
          width: 1280,
          height: 720,
        }),
      }),
    ),
  );

  // 历史栈：后退回第一页
  await user.click(screen.getByRole("button", { name: "后退" }));
  await waitFor(() =>
    expect(screen.getByLabelText("地址栏").getAttribute("value")).toBe(
      "https://example.com",
    ),
  );
  // 后退后前进恢复
  await user.click(screen.getByRole("button", { name: "前进" }));
  await waitFor(() =>
    expect(screen.getByLabelText("地址栏").getAttribute("value")).toBe(
      "https://another.example.org",
    ),
  );
});

test("未连接时自动以无头模式连一次再开流", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/status") {
      return { status: "disconnected" };
    }
    if (path === "/api/browser/cdp/connect") {
      return { status: "connected" };
    }
    if (path === "/api/browser/cdp/view") {
      return {
        ticket: "t2",
        viewport: { width: 1280, height: 720, scale: 1 },
      };
    }
    return {};
  });
  render(<BrowserPane initialUrl="https://example.com" />);
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/connect",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ headless: true }),
      }),
    ),
  );
  await screen.findByAltText("浏览器画面");
});

test("连接失败显示可读原因与重载入口；调试控制台按钮调 console 注入", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/status") {
      return {
        status: "error",
        message: "端口未开",
      };
    }
    if (path === "/api/browser/cdp/connect") {
      return { status: "error", message: "浏览器没起来" };
    }
    if (path === "/api/browser/cdp/console") {
      return {};
    }
    return {};
  });
  render(<BrowserPane initialUrl="https://example.com" />);
  await waitFor(() => expect(screen.getByText("浏览器没起来")).toBeTruthy());
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "调试控制台" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith("/api/browser/cdp/console", {
      method: "POST",
    }),
  );
});

test("视口预设切换改变 view 的 width/height（真视口，非缩放伪装）", async () => {
  connectedApis();
  render(<BrowserPane initialUrl="https://example.com" />);
  await screen.findByAltText("浏览器画面");
  await user.click(screen.getByRole("button", { name: "375 × 812" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com",
          width: 375,
          height: 812,
        }),
      }),
    ),
  );
});
