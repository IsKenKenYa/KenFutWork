import { createRequire } from "node:module";
import { vi } from "vitest";

type TestDom = { window: Window & typeof globalThis & { close(): void } };

/** 服务端先在Node装配，再给原组件安装独立DOM；不改变服务端的URL解析。 */
export async function installCodePublicHostDom() {
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
    url: "http://localhost:3300",
    pretendToBeVisual: true,
  });
  const browserWindow = dom.window;
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
    "localStorage",
  ] as const) {
    vi.stubGlobal(key, browserWindow[key]);
  }
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
