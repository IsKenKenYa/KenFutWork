import { vi } from "vitest";

const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTo",
);
export function installCodeRootBrowser() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value() {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

export function restoreCodeRootBrowser() {
  if (scrollToDescriptor)
    Object.defineProperty(Element.prototype, "scrollTo", scrollToDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollTo");
}
