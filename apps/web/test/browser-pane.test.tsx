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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

test("进入拾取自动收起调试控制台悬浮窗", async () => {
  connectedApis();
  surfaceJson.mockImplementation(async (path: string) => {
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

test("元素选择器：进入注入脚本+收控制台；点选读取结果填 chip；Esc 退出发 stop", async () => {
  connectedApis();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/browser/cdp/picker") {
      const action = JSON.parse(String(init?.body)).action as string;
      if (action === "start") return { ok: true };
      if (action === "stop") return { ok: true };
      return {
        picked: {
          tag: "a",
          text: "Learn more",
          hint: "a.pick-me",
          box: { x: 40, y: 60, width: 120, height: 20 },
          viewport: { width: 1280, height: 720 },
          page: "https://example.com/",
        },
        active: false,
        error: null,
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
  // 进入：先收控制台再注入选择器
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/console",
      expect.objectContaining({ body: JSON.stringify({ action: "close" }) }),
    ),
  );
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/picker",
      expect.objectContaining({ body: JSON.stringify({ action: "start" }) }),
    ),
  );

  // 画面上「按下→抬起」（面板转发 CDP 输入；页面脚本已在 mousedown 存好元素）
  const stage = screen.getByRole("group", { name: "内嵌浏览器画面" });
  fireEvent.mouseDown(stage, { clientX: 100, clientY: 70, button: 0 });
  // 回归锁：拾取中「按下」也必须转发——页面内选择器正是靠 mousedown 记录元素，
  // 吞掉按下（旧 bug）页面永远收不到点选，read 恒为空
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/input",
      expect.objectContaining({
        body: JSON.stringify({
          type: "mouse",
          action: "pressed",
          x: 100,
          y: 70,
          button: "left",
          buttons: 1,
          modifiers: 0,
        }),
      }),
    ),
  );
  fireEvent.mouseUp(stage, { clientX: 100, clientY: 70, button: 0 });
  await waitFor(() =>
    expect(requestComposerTextInsert).toHaveBeenCalledWith(
      "D:/Desktop/test",
      expect.stringContaining(
        "[<a> Learn more](browser-element://pick?x=100&y=70",
      ),
      "ws-1",
      expect.objectContaining({ category: "browser" }),
    ),
  );
});

test("元素选择器：点空白/图层（picked 为空）保持选择模式", async () => {
  connectedApis();
  surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/browser/cdp/picker") {
      const action = JSON.parse(String(init?.body)).action as string;
      if (action === "start") return { ok: true };
      if (action === "stop") return { ok: true };
      return { picked: null, active: true, error: null };
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
      "/api/browser/cdp/picker",
      expect.objectContaining({ body: JSON.stringify({ action: "start" }) }),
    ),
  );
  const stage = screen.getByRole("group", { name: "内嵌浏览器画面" });
  fireEvent.mouseDown(stage, { clientX: 50, clientY: 50, button: 0 });
  fireEvent.mouseUp(stage, { clientX: 50, clientY: 50, button: 0 });
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/picker",
      expect.objectContaining({ body: JSON.stringify({ action: "read" }) }),
    ),
  );
  // 没选中任何东西：不发引用、保持选择模式
  expect(requestComposerTextInsert).not.toHaveBeenCalled();

  // Esc 退出发 stop
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/picker",
      expect.objectContaining({ body: JSON.stringify({ action: "stop" }) }),
    ),
  );
});

/**
 * 「僵尸选择器」回归锁：页面里注入的选择器必须与面板拾取态同生共死——
 * 只清面板状态不收页面选择器时，高亮照常跟鼠标走、点击被页面拦截，
 * 但没人来 read，元素永远进不了对话（真机用户实测踩过）。
 */
describe("元素选择器：退出必须两侧一起收（防僵尸选择器）", () => {
  function pickerApis(options?: { readFails?: boolean }) {
    surfaceJson.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/browser/cdp/picker") {
        const action = JSON.parse(String(init?.body)).action as string;
        if (action === "start") return { ok: true };
        if (action === "stop") return { ok: true };
        if (options?.readFails) throw new Error("服务重启中");
        return {
          picked: {
            tag: "a",
            text: "Learn more",
            hint: "a.pick-me",
            box: { x: 40, y: 60, width: 120, height: 20 },
            viewport: { width: 1280, height: 720 },
            page: "https://example.com/",
          },
          active: true,
          error: null,
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
  }

  async function enterPicking() {
    render(<BrowserPane initialUrl="https://example.com" />);
    await enableFreeSize();
    await screen.findByAltText("浏览器画面");
    await user.click(
      screen.getByRole("button", { name: "选择网页元素加入聊天" }),
    );
    await waitFor(() =>
      expect(surfaceJson).toHaveBeenCalledWith(
        "/api/browser/cdp/picker",
        expect.objectContaining({ body: JSON.stringify({ action: "start" }) }),
      ),
    );
  }

  test("read 失败（服务重启窗口）：发 stop 收页面选择器，并退出拾取", async () => {
    pickerApis({ readFails: true });
    await enterPicking();
    const stage = screen.getByRole("group", { name: "内嵌浏览器画面" });
    fireEvent.mouseDown(stage, { clientX: 100, clientY: 70, button: 0 });
    fireEvent.mouseUp(stage, { clientX: 100, clientY: 70, button: 0 });
    await waitFor(() =>
      expect(surfaceJson).toHaveBeenCalledWith(
        "/api/browser/cdp/picker",
        expect.objectContaining({ body: JSON.stringify({ action: "stop" }) }),
      ),
    );
    // 已退出拾取：再点按钮走的是重新 start（而不是 stop）
    surfaceJson.mockClear();
    pickerApis();
    await user.click(
      screen.getByRole("button", { name: "选择网页元素加入聊天" }),
    );
    await waitFor(() =>
      expect(surfaceJson).toHaveBeenCalledWith(
        "/api/browser/cdp/picker",
        expect.objectContaining({ body: JSON.stringify({ action: "start" }) }),
      ),
    );
    expect(requestComposerTextInsert).not.toHaveBeenCalled();
  });

  test("画面断线重连：在拾取先收掉（不赌页面选择器还活着）", async () => {
    pickerApis();
    await enterPicking();
    fireEvent.error(screen.getByAltText("浏览器画面"));
    await waitFor(() =>
      expect(surfaceJson).toHaveBeenCalledWith(
        "/api/browser/cdp/picker",
        expect.objectContaining({ body: JSON.stringify({ action: "stop" }) }),
      ),
    );
  });

  test("卸载面板（切内容标签/HMR）：发 stop 收页面选择器", async () => {
    pickerApis();
    await enterPicking();
    cleanup();
    await waitFor(() =>
      expect(surfaceJson).toHaveBeenCalledWith(
        "/api/browser/cdp/picker",
        expect.objectContaining({ body: JSON.stringify({ action: "stop" }) }),
      ),
    );
  });
});
