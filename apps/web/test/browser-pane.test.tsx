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
import { TooltipProvider } from "@zui/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@zui/i18n/IntlProvider";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// web 工程没有 @zcode/shared 路径映射（运行时经 cuaSharedAdapter 别名），TID 直接取构建产物
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_BACK_BUTTON,
  TID_BROWSER_DEVTOOLS_BUTTON,
  TID_BROWSER_ELEMENT_PICKER_BUTTON,
  TID_BROWSER_FORWARD_BUTTON,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
  TID_BROWSER_REFRESH_BUTTON,
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_RESIZE_WIDTH,
  TID_BROWSER_RESPONSIVE_TOOLBAR,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_BROWSER_RESPONSIVE_ZOOM_SELECT,
} from "../../../packages/zcode-shared/dist/index.js";

const surfaceJson = vi.fn();
const requestComposerTextInsert = vi.fn();
const toast = vi.spyOn(notifications, "toast");

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

// jsdom 没有 ResizeObserver（ResponsiveBrowserViewport 的 Fit 测量用）；
// 直接补 window/globalThis，不依赖 stubGlobal 的时序。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
for (const host of [globalThis, window]) {
  if (!("ResizeObserver" in host)) {
    (host as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  }
}

/** Radix 下拉在跨用例后 pointer 路径不稳定；键盘 Enter 开菜单是同一交互。 */
function openMoreMenu(): void {
  const trigger = screen.getByTestId(TID_BROWSER_MORE_BUTTON);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter", bubbles: true });
}

function renderPane(props: Parameters<typeof BrowserPane>[0]) {
  return render(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <BrowserPane {...props} />
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );
}

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
});

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

test("无初始地址：停在开始态不再假加载；不发任何请求；输入地址后正常开流", async () => {
  connectedApis();
  renderPane({});
  // 开始态给可读空态（浏览器 + 输入提示），而不是「正在打开内嵌浏览器…」
  expect(await screen.findByText("粘贴或输入 URL 以打开网页。")).toBeTruthy();
  expect(screen.queryByText("正在打开内嵌浏览器…")).toBeNull();
  // 关键回归：不再发起任何数据面请求（旧实现此时卡在 connecting 且永不返回）
  expect(surfaceJson).not.toHaveBeenCalled();

  const address = screen.getByTestId(TID_BROWSER_ADDRESS_INPUT);
  await user.click(address);
  await user.type(address, "example.com");
  await user.keyboard("{Enter}");
  const img = await screen.findByAltText("浏览器画面");
  await waitFor(() =>
    expect(img.getAttribute("src")).toBe(
      "/api/browser/cdp/stream?ticket=ticket-1280x720",
    ),
  );
});

test("连接→开流→MJPEG 画面渲染；地址栏导航走 view；历史栈前进后退", async () => {
  connectedApis();
  renderPane({ initialUrl: "https://example.com" });
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

  // 地址栏导航：补协议、压栈
  const address = screen.getByTestId(TID_BROWSER_ADDRESS_INPUT);
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
  await user.click(screen.getByTestId(TID_BROWSER_BACK_BUTTON));
  await waitFor(() =>
    expect(
      screen.getByTestId(TID_BROWSER_ADDRESS_INPUT).getAttribute("value"),
    ).toBe("https://example.com"),
  );
  // 后退后前进恢复
  await user.click(screen.getByTestId(TID_BROWSER_FORWARD_BUTTON));
  await waitFor(() =>
    expect(
      screen.getByTestId(TID_BROWSER_ADDRESS_INPUT).getAttribute("value"),
    ).toBe("https://another.example.org"),
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
  renderPane({ initialUrl: "https://example.com" });
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

test("连接失败显示可读原因与重载入口；更多菜单里可注入调试控制台", async () => {
  surfaceJson.mockImplementation(async (path: string) => {
    if (path === "/api/browser/cdp/status") {
      return {
        cdp: {
          status: "error",
          message: "端口未开",
        },
      };
    }
    if (path === "/api/browser/cdp/connect") {
      return { cdp: { status: "error", message: "浏览器没起来" } };
    }
    if (path === "/api/browser/cdp/console") {
      return {};
    }
    return {};
  });
  renderPane({ initialUrl: "https://example.com" });
  await waitFor(() => expect(screen.getByText("浏览器没起来")).toBeTruthy());
  expect(screen.getByRole("button", { name: "重新加载" })).toBeTruthy();
  // 画面没起来时调试工具入口置灰（不摆假开关）
  openMoreMenu();
  const devtools = await screen.findByTestId(TID_BROWSER_DEVTOOLS_BUTTON);
  expect(devtools.getAttribute("aria-disabled")).toBe("true");
});

test("更多菜单：在默认浏览器中打开当前页、注入调试控制台", async () => {
  connectedApis();
  const openExternal = vi.fn();
  const originalOpen = window.open;
  window.open = openExternal as unknown as typeof window.open;
  try {
    renderPane({ initialUrl: "https://example.com" });
    await screen.findByAltText("浏览器画面");
    openMoreMenu();
    const item = await screen.findByTestId(TID_BROWSER_OPEN_EXTERNAL_ITEM);
    await user.click(item);
    expect(openExternal).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
    // 调试控制台注入（live 态可用）
    openMoreMenu();
    const devtools = await screen.findByTestId(TID_BROWSER_DEVTOOLS_BUTTON);
    await user.click(devtools);
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

test("视口预设切换改变 view 的 width/height（真视口，非缩放伪装）", async () => {
  connectedApis();
  renderPane({ initialUrl: "https://example.com" });
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

test("自由尺寸：开关后出现宽高输入与缩放档；改宽提交按新尺寸重开画面", async () => {
  connectedApis();
  renderPane({ initialUrl: "https://example.com" });
  await screen.findByAltText("浏览器画面");

  // 默认预设行，无自由尺寸行
  expect(screen.queryByTestId(TID_BROWSER_RESPONSIVE_TOOLBAR)).toBeNull();
  await user.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
  expect(
    await screen.findByTestId(TID_BROWSER_RESPONSIVE_TOOLBAR),
  ).toBeTruthy();
  // 预设行收起（自由尺寸行替代它）
  expect(screen.queryByRole("button", { name: "375 × 812" })).toBeNull();

  const width = screen.getByTestId(TID_BROWSER_RESPONSIVE_WIDTH_INPUT);
  await user.clear(width);
  await user.type(width, "900");
  await user.keyboard("{Enter}");
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

  // 键盘把手：宽度把手 ArrowRight +1（聚焦即提交当前值 +1）
  surfaceJson.mockClear();
  const height = screen.getByTestId(TID_BROWSER_RESPONSIVE_HEIGHT_INPUT);
  await user.clear(height);
  await user.type(height, "600");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com",
          width: 900,
          height: 600,
        }),
      }),
    ),
  );

  const rightHandle = screen.getByTestId(TID_BROWSER_RESPONSIVE_RESIZE_WIDTH);
  rightHandle.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/cdp/view",
      expect.objectContaining({
        body: JSON.stringify({
          url: "https://example.com",
          width: 901,
          height: 600,
        }),
      }),
    ),
  );

  // 缩放档是纯显示层控件：与 browser-use 面板同一组件，存在即到位；
  // 改缩放不触发 view 重开（onViewportSizeChange 之外的状态不进数据面）。
  expect(screen.getByTestId(TID_BROWSER_RESPONSIVE_ZOOM_SELECT)).toBeTruthy();
  // 再点一次开关退回预设行
  await user.click(screen.getByTestId(TID_BROWSER_RESPONSIVE_BUTTON));
  expect(screen.queryByTestId(TID_BROWSER_RESPONSIVE_TOOLBAR)).toBeNull();
  expect(screen.getByRole("button", { name: "375 × 812" })).toBeTruthy();
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
  renderPane({
    initialUrl: "https://example.com",
    workspacePath: "D:/Desktop/test",
    workspaceIdentity: "ws-1",
  });
  await screen.findByAltText("浏览器画面");

  await user.click(screen.getByTestId(TID_BROWSER_ELEMENT_PICKER_BUTTON));
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
  renderPane({ initialUrl: "https://example.com" });
  await screen.findByAltText("浏览器画面");

  await user.click(screen.getByTestId(TID_BROWSER_ELEMENT_PICKER_BUTTON));
  await waitFor(() =>
    expect(surfaceJson).toHaveBeenCalledWith(
      "/api/browser/snapshot",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  expect(screen.getByText("点选元素填入输入框 · Esc 取消")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByText("点选元素填入输入框 · Esc 取消")).toBeNull(),
  );

  // 刷新：重开 view 且带 reload: true
  await user.click(screen.getByTestId(TID_BROWSER_REFRESH_BUTTON));
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
