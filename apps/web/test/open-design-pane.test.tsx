import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const entryRef = { current: null as unknown };

vi.mock("../src/components/workbench/zcode/host/openDesignHost.js", () => ({
  useOpenDesignEntry: () => entryRef.current,
}));

const { OpenDesignPane } = await import(
  "../src/components/workbench/zcode/host/OpenDesignPane.js"
);

const ORIGIN = "http://127.0.0.1:7456";

afterEach(() => {
  cleanup();
  entryRef.current = null;
});

function mount(available = true) {
  entryRef.current = available
    ? { available: true, frontendUrl: ORIGIN }
    : { available: false, reason: "未就绪。" };
  const view = render(<OpenDesignPane />);
  fireEvent.load(screen.getByTitle("OpenDesign"));
  return view;
}

function paneRoot() {
  return screen.getByTestId("open-design-pane");
}

test("上游回 hello → 握手成立（ok）", () => {
  mount();
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "od/hello", version: "v1" },
        origin: ORIGIN,
      }),
    );
  });
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("ok");
});

test("跨源 hello 不放行：origin 白名单是第一道闸", () => {
  mount();
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "od/hello", version: "v1" },
        origin: "http://evil.example.com",
      }),
    );
  });
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("pending");
});

test("形状不明的消息不放行：schema 是第二道闸", () => {
  mount();
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "od/hello" },
        origin: ORIGIN,
      }),
    );
  });
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("pending");
});

test("上游不回话：画布照常挂载，握手保持 pending（深链已移除，无提示条）", () => {
  mount();
  expect(screen.getByTitle("OpenDesign")).toBeTruthy();
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("pending");
  expect(screen.queryByText(/暂不支持/)).toBeNull();
});
