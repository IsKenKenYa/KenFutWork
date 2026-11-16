import { createRequire } from "node:module";
import { vi } from "vitest";

type TestDom = { window: Window & typeof globalThis & { close(): void } };

/** 服务端先在Node装配，再给原组件安装独立DOM；不改变服务端的URL解析。 */
export async function installCodePublicHostDom(options: { url?: string } = {}) {
  // 真实服务先在 Node 环境装配；仅给随后加载的原组件提供 DOM。
  const {
    JSDOM,
  }: {
    JSDOM: new (
      html: string,
      options: { url: string; pretendToBeVisual: boolean },
    ) => TestDom;
  } = createRequire(import.meta.url)("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: options.url ?? "http://localhost:3300",
    pretendToBeVisual: true,
  });
  const browserWindow = dom.window;
  // JSDOM 没有布局滚动；下拉菜单仍使用实际焦点及键盘逻辑。
  if (!browserWindow.HTMLElement.prototype.scrollIntoView)
    browserWindow.HTMLElement.prototype.scrollIntoView = () => {};
  // JSDOM未实现PointerEvent时，只补鼠标型指针字段；产品PointerSensor保持原实现。
  const pointerEvent =
    browserWindow.PointerEvent ??
    class extends browserWindow.MouseEvent {
      readonly pointerId: number;
      readonly isPrimary: boolean;
      readonly pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.isPrimary = init.isPrimary ?? true;
        this.pointerType = init.pointerType ?? "mouse";
      }
    };
  Object.defineProperty(browserWindow, "PointerEvent", {
    configurable: true,
    value: pointerEvent,
  });
  vi.stubGlobal("PointerEvent", pointerEvent);
  for (const key of [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "Image",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLFormElement",
    "SVGElement",
    "Node",
    "NodeFilter",
    "Document",
    "DocumentFragment",
    "ShadowRoot",
    "MutationObserver",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "CustomEvent",
    "customElements",
  ] as const) {
    vi.stubGlobal(key, browserWindow[key]);
  }
  // 不在安装 DOM 时访问 localStorage，允许验证浏览器实际拒绝存储的场景。
  vi.stubGlobal("localStorage", undefined);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => browserWindow.localStorage,
  });
  vi.stubGlobal(
    "getComputedStyle",
    browserWindow.getComputedStyle.bind(browserWindow),
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    browserWindow.requestAnimationFrame.bind(browserWindow),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    browserWindow.cancelAnimationFrame.bind(browserWindow),
  );
  const browser = await import("./code-root-host-browser");
  browser.installCodeRootBrowser();
  return () => {
    browser.restoreCodeRootBrowser();
    dom.window.close();
  };
}
