import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();
const requestComposerTextInsert = vi.fn();

vi.mock("@zui/host/surfaceApi.js", () => ({
  surfaceJson: (path: string, init?: RequestInit) => surfaceJson(path, init),
  getSurfaceApiBase: () => "",
}));

vi.mock("@zui/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: {
    getState: () => ({ requestComposerTextInsert }),
  },
}));

const { BrowserPane } = await import(
  "../src/components/workbench/zcode/host/BrowserPane.js"
);

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  surfaceJson.mockReset();
  requestComposerTextInsert.mockReset();
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
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

test("拾取元素：snapshot 拉盒模型→叠框→点选把坐标引用填进 composer", async () => {
  connectedApis();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/browser/snapshot") {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://example.com",
      });
      return {
        snapshot: {
          url: "https://example.com",
          title: "示例",
          viewport: { width: 1280, height: 720 },
          elements: [
            {
              tag: "button",
              text: "提交订单",
              hint: "立即购买",
              box: { x: 100, y: 50, width: 200, height: 40 },
            },
            { tag: "a", text: "无几何", hint: "", box: null },
          ],
        },
        source: "cdp",
      };
    }
    if (path === "/api/browser/cdp/status") {
      return { status: "connected", currentUrl: "https://example.com" };
    }
    if (path === "/api/browser/cdp/view") {
      return {
        ticket: "ticket-1",
        viewport: { width: 1280, height: 720, scale: 1 },
      };
    }
    return {};
  });
  render(
    <BrowserPane
      initialUrl="https://example.com"
      workspacePath="D:/Desktop/test"
      workspaceIdentity="ws-1"
    />,
  );
  await screen.findByAltText("浏览器画面");

  await user.click(screen.getByRole("button", { name: "拾取元素" }));
  const box = await screen.findByRole("button", { name: "拾取 button" });
  // 视口 1280×720 下盒 {100,50,200,40} → 百分比定位
  expect(box.getAttribute("style")).toContain("left: 7.8125%");
  expect(box.getAttribute("style")).toContain("top: 6.944444444444445%");
  expect(box.getAttribute("style")).toContain("width: 15.625%");
  expect(box.getAttribute("style")).toContain("height: 5.555555555555555%");
  // 无几何元素不叠框（只进不了列表热点）
  expect(screen.queryByRole("button", { name: "拾取 a" })).toBeNull();

  // jsdom 无布局（矩形全零），userEvent 的坐标命中会落到 (0,0) 的 img 上；
  // 叠框按钮用 fireEvent 直派 click（与真实浏览器点选同一处理器）。
  fireEvent.click(box);
  await waitFor(() =>
    expect(requestComposerTextInsert).toHaveBeenCalledWith(
      "D:/Desktop/test",
      "【页面元素】<button> 提交订单 ｜ 定位提示：立即购买 ｜ 中心坐标：200,70 ｜ 视口：1280×720 ｜ 来自：https://example.com",
      "ws-1",
    ),
  );
  // 点选后退出拾取态
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "拾取 button" })).toBeNull(),
  );
});

test("拾取中 Esc 退出；调试控制台注入带上当前 url", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/snapshot") {
      return {
        snapshot: {
          url: "https://example.com",
          title: "示例",
          viewport: { width: 1280, height: 720 },
          elements: [],
        },
        source: "cdp",
      };
    }
    if (path === "/api/browser/cdp/status") {
      return { status: "connected", currentUrl: "https://example.com" };
    }
    if (path === "/api/browser/cdp/view") {
      return {
        ticket: "ticket-1",
        viewport: { width: 1280, height: 720, scale: 1 },
      };
    }
    return {};
  });
  render(<BrowserPane initialUrl="https://example.com" />);
  await screen.findByAltText("浏览器画面");

  await user.click(screen.getByRole("button", { name: "拾取元素" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/snapshot",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(screen.getByText("点选元素填入输入框 · Esc 取消")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByText("点选元素填入输入框 · Esc 取消"),
    ).toBeNull(),
  );

  await user.click(screen.getByRole("button", { name: "调试控制台" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith("/api/browser/cdp/console", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    }),
  );
});
