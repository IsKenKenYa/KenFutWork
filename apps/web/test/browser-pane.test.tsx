import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as notifications from "@zui/components/ui/toast.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const surfaceJson = vi.fn();
const requestComposerTextInsert = vi.fn();
const dispatchBrowserScreenshotAddToChat = vi.fn();
const toast = vi.spyOn(notifications, "toast");

vi.mock("@zui/lib/browserScreenshotChat.js", () => ({
  dispatchBrowserScreenshotAddToChat: (payload: unknown) =>
    dispatchBrowserScreenshotAddToChat(payload),
}));

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

// userEvent 实例带指针/键盘内部状态，跨用例复用会让后续 click 失真；
// 每个用例前重建（用例体内直接引用本绑定，无需逐用例改写）。
let user = userEvent.setup();
beforeEach(() => {
  user = userEvent.setup();
});

afterEach(async () => {
  cleanup();
  // 通知自建根不属于Testing Library；按公开句柄关闭真实通知及其计时器。
  await act(async () => {
    for (const result of toast.mock.results) {
      if (result.type === "return") notifications.dismissToast(result.value);
    }
  });
  toast.mockClear();
  surfaceJson.mockReset();
  requestComposerTextInsert.mockReset();
  dispatchBrowserScreenshotAddToChat.mockReset();
});

/** Radix 下拉在跨用例后 pointer 路径不稳定；键盘 Enter 开菜单是同一交互。 */
function openBrowserMenu(): void {
  const trigger = screen.getByRole("button", { name: "浏览器菜单" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter", bubbles: true });
}

/** jsdom 无布局（面板量出来是 0×0），开自由尺寸让视口取输入值。 */
async function enableFreeSize(): Promise<void> {
  await user.click(screen.getByRole("button", { name: "自由尺寸" }));
}

function connectedApis() {
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    // 信封与服务端一致：`{ cdp: {...} }`（见 apps/server/src/features/browser/plugin.ts）。
    if (path === "/api/browser/cdp/status") {
      return { cdp: { status: "connected", currentUrl: "" } };
    }
    if (path === "/api/browser/cdp/view") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        width: number;
        height: number;
      };
      return {
        ticket: `ticket-${body.width}x${body.height}`,
        viewport: { width: body.width, height: body.height, scale: 1 },
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

test("无初始地址：空态不再假加载、零请求；输入地址后按自由尺寸视口开流", async () => {
  connectedApis();
  render(<BrowserPane />);
  expect(await screen.findByText("还没有打开页面")).toBeTruthy();
  expect(screen.getByText("输入地址开始浏览")).toBeTruthy();
  expect(screen.queryByText("正在打开内嵌浏览器…")).toBeNull();
  // 关键回归：不再发起任何数据面请求（旧实现此处卡在 connecting 且永不返回）
  expect(surfaceJson).not.toHaveBeenCalled();

  // jsdom 无布局：开自由尺寸后视口取输入值（1280×720）
  await enableFreeSize();
  expect(screen.getByTestId("browser-free-size-width")).toBeTruthy();
  const address = screen.getByLabelText("地址");
  await user.click(address);
  await user.type(address, "example.com");
  await user.keyboard("{Enter}");
  const img = await screen.findByAltText("浏览器画面");
  await waitFor(() =>
    expect(img.getAttribute("src")).toBe(
      "/api/browser/cdp/stream?ticket=ticket-1280x720",
    ),
  );
  expect(surfaceJson).toHaveBeenCalledWith(
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
});

test("本地地址默认 http、外网默认 https（旧版归一化口径）", async () => {
  connectedApis();
  render(<BrowserPane initialUrl="https://example.com" />);
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");
  const address = screen.getByLabelText("地址");
  await user.clear(address);
  await user.type(address, "localhost:3300");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "http://localhost:3300",
          width: 1280,
          height: 720,
        }),
      }),
    ),
  );
});

test("未连接时自动以无头模式连一次再开流", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/status") {
      return { cdp: { status: "disconnected" } };
    }
    if (path === "/api/browser/cdp/connect") {
      return { cdp: { status: "connected" } };
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
  await enableFreeSize();
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

test("地址栏导航压栈；历史栈后退/前进", async () => {
  connectedApis();
  render(<BrowserPane initialUrl="https://example.com" />);
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");

  const address = screen.getByLabelText("地址");
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

  await user.click(screen.getByRole("button", { name: "后退" }));
  await waitFor(() =>
    expect(screen.getByLabelText("地址").getAttribute("value")).toBe(
      "https://example.com",
    ),
  );
  await user.click(screen.getByRole("button", { name: "前进" }));
  await waitFor(() =>
    expect(screen.getByLabelText("地址").getAttribute("value")).toBe(
      "https://another.example.org",
    ),
  );
});

test("连接失败显示可读原因与重载入口", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/status") {
      return { cdp: { status: "error", message: "端口未开" } };
    }
    if (path === "/api/browser/cdp/connect") {
      return { cdp: { status: "error", message: "浏览器没起来" } };
    }
    return {};
  });
  render(<BrowserPane initialUrl="https://example.com" />);
  await enableFreeSize();
  await waitFor(() => expect(screen.getByText("浏览器没起来")).toBeTruthy());
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
});

test("⋯菜单：在默认浏览器中打开当前页；打开调试工具先连 CDP 再注入", async () => {
  connectedApis();
  const openExternal = vi.fn();
  const originalOpen = window.open;
  window.open = openExternal as unknown as typeof window.open;
  try {
    render(<BrowserPane initialUrl="https://example.com" />);
    await enableFreeSize();
    await screen.findByAltText("浏览器画面");

    openBrowserMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "在默认浏览器中打开" }),
    );
    expect(openExternal).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener",
    );

    openBrowserMenu();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "打开调试工具" }),
    );
    await waitFor(() =>
      expect(surfaceJson).toHaveBeenCalledWith("/api/browser/cdp/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      }),
    );
  } finally {
    window.open = originalOpen;
  }
});

test("调试工具在受控浏览器未连时先连再注入（点一下就该能用）", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/status") {
      return { cdp: { status: "disconnected" } };
    }
    if (path === "/api/browser/cdp/connect") {
      return { cdp: { status: "connected" } };
    }
    if (path === "/api/browser/cdp/console") {
      return {};
    }
    return {};
  });
  render(<BrowserPane />);
  openBrowserMenu();
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "打开调试工具" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/connect",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith("/api/browser/cdp/console", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "about:blank" }),
    }),
  );
});

test("自由尺寸：改宽提交按新视口重开；拖拽把手改宽高；缩放档是纯显示层", async () => {
  connectedApis();
  render(<BrowserPane initialUrl="https://example.com" />);
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");

  // 改宽 900（打字期间合法值即时提交）
  const width = screen.getByTestId("browser-free-size-width");
  await user.clear(width);
  await user.type(width, "900");
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com",
          width: 900,
          height: 720,
        }),
      }),
    ),
  );

  // 拖拽把手：+80 / +60 → 980×780
  surfaceJson.mockClear();
  const handle = screen.getByTestId("browser-free-size-handle");
  fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 180, clientY: 160 });
  fireEvent.mouseUp(window);
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com",
          width: 980,
          height: 780,
        }),
      }),
    ),
  );

  // 缩放档存在且不影响数据面（只改显示 scale）
  surfaceJson.mockClear();
  expect(screen.getByTestId("browser-zoom-select")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "退出自由尺寸" }));
  expect(screen.queryByTestId("browser-zoom-select")).toBeNull();
  expect(surfaceJson).not.toHaveBeenCalled();
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
      return {
        cdp: { status: "connected", currentUrl: "https://example.com" },
      };
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
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");

  await user.click(
    screen.getByRole("button", { name: "选择网页元素加入聊天" }),
  );
  const box = await screen.findByRole("button", { name: "拾取 button" });
  // 视口 1280×720 下盒 {100,50,200,40} → 百分比定位
  expect(box.getAttribute("style")).toContain("left: 7.8125%");
  expect(box.getAttribute("style")).toContain("top: 6.944444444444445%");
  expect(box.getAttribute("style")).toContain("width: 15.625%");
  expect(box.getAttribute("style")).toContain("height: 5.555555555555555%");
  expect(screen.queryByRole("button", { name: "拾取 a" })).toBeNull();

  // jsdom 无布局（矩形全零），叠框按钮用 fireEvent 直派 click（同一处理器）。
  fireEvent.click(box);
  // 缩略形态：插入的是 browser 元素 chip 的 markdown（坐标/视口/来源进 target query）
  await waitFor(() =>
    expect(requestComposerTextInsert).toHaveBeenCalledWith(
      "D:/Desktop/test",
      expect.stringContaining(
        "[<button> 提交订单](browser-element://pick?x=200&y=70",
      ),
      "ws-1",
      expect.objectContaining({
        category: "browser",
        value: expect.stringContaining("from="),
        markdown: expect.stringContaining("browser-element://pick?x=200"),
      }),
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "拾取 button" })).toBeNull(),
  );
});

test("拾取中 Esc 退出；刷新按钮触发重开（带 reload 标记）", async () => {
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
      return {
        cdp: { status: "connected", currentUrl: "https://example.com" },
      };
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
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");

  await user.click(
    screen.getByRole("button", { name: "选择网页元素加入聊天" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/snapshot",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(
    screen.getByText("悬停切换元素 · 点击加入对话 · Esc 取消"),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByText("悬停切换元素 · 点击加入对话 · Esc 取消"),
    ).toBeNull(),
  );

  await user.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com",
          width: 1280,
          height: 720,
          reload: true,
        }),
      }),
    ),
  );
});

test("拾取悬浮切换：悬停元素亮起并显示标签，点击加入的正是悬停的那个", async () => {
  connectedApis();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/browser/snapshot") {
      return {
        snapshot: {
          url: "https://example.com",
          title: "示例",
          viewport: { width: 1280, height: 720 },
          elements: [
            {
              tag: "a",
              text: "链接一",
              hint: "a.one",
              box: { x: 0, y: 0, width: 100, height: 20 },
            },
            {
              tag: "button",
              text: "按钮二",
              hint: "button.two",
              box: { x: 0, y: 40, width: 100, height: 20 },
            },
          ],
        },
        source: "cdp",
      };
    }
    if (path === "/api/browser/cdp/status") {
      return { cdp: { status: "connected" } };
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
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");

  await user.click(
    screen.getByRole("button", { name: "选择网页元素加入聊天" }),
  );
  const first = await screen.findByRole("button", { name: "拾取 a" });
  const second = screen.getByRole("button", { name: "拾取 button" });
  // 默认无悬停标签
  expect(screen.queryByText("<a> 链接一")).toBeNull();
  // 悬停第二个：亮起 + 标签出现；点击加入的正是它
  fireEvent.mouseEnter(second);
  expect(await screen.findByText("<button> 按钮二")).toBeTruthy();
  expect(second.getAttribute("class")).toContain("bg-primary/45");
  expect(first.getAttribute("class")).not.toContain("bg-primary/45");
  fireEvent.click(second);
  await waitFor(() =>
    expect(requestComposerTextInsert).toHaveBeenCalledWith(
      "D:/Desktop/test",
      expect.stringContaining("[<button> 按钮二](browser-element://pick?"),
      "ws-1",
      expect.objectContaining({ category: "browser" }),
    ),
  );
});

test("进入拾取自动收起调试控制台悬浮窗", async () => {
  connectedApis();
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
      return { cdp: { status: "connected" } };
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
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");
  await user.click(
    screen.getByRole("button", { name: "选择网页元素加入聊天" }),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/console",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "close" }),
      }),
    ),
  );
});

test("截图到对话：菜单项截当前视口并派发 PNG 附件事件", async () => {
  connectedApis();
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/screenshot") {
      return {
        base64: Buffer.from("fake-png").toString("base64"),
        width: 1280,
        height: 720,
      };
    }
    if (path === "/api/browser/cdp/status") {
      return { cdp: { status: "connected" } };
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
    />,
  );
  await enableFreeSize();
  await screen.findByAltText("浏览器画面");

  openBrowserMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "截图到对话" }));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/screenshot",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  await waitFor(() =>
    expect(dispatchBrowserScreenshotAddToChat).toHaveBeenCalledWith(
      expect.objectContaining({
        title: null,
        workspacePath: "D:/Desktop/test",
        file: expect.any(File),
      }),
    ),
  );
});
