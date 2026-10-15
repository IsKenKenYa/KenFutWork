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

const { OpenDesignPane, OD_HANDSHAKE_TIMEOUT_MS } = await import(
  "../src/components/workbench/zcode/host/OpenDesignPane.js"
);

const ORIGIN = "http://127.0.0.1:7456";

afterEach(() => {
  cleanup();
  entryRef.current = null;
  vi.useRealTimers();
});

function mount(available: boolean, navigatePath?: string) {
  entryRef.current = available
    ? { available: true, frontendUrl: ORIGIN }
    : { available: false, reason: "未就绪。" };
  const view = render(<OpenDesignPane navigatePath={navigatePath ?? null} />);
  fireEvent.load(screen.getByTitle("OpenDesign"));
  return view;
}

function paneRoot() {
  return screen.getByTestId("open-design-pane");
}

async function advanceHandshakeTimeout() {
  await act(async () => {
    vi.advanceTimersByTime(OD_HANDSHAKE_TIMEOUT_MS + 50);
  });
}

test("带深链 + 上游握手无回执 → 时限后置 rejected 并给可读提示（不静默）", async () => {
  vi.useFakeTimers();
  mount(true, "/src/app.tsx");
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("pending");
  expect(screen.queryByText(/暂不支持打开指定文件/)).toBeNull();

  await advanceHandshakeTimeout();
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("rejected");
  expect(
    screen.getByText("该 OpenDesign 版本暂不支持打开指定文件"),
  ).toBeTruthy();
});

test("上游回 hello → 握手成立：超时后也不提示，深链照发", async () => {
  vi.useFakeTimers();
  mount(true, "/src/app.tsx");
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "od/hello", version: "v1" },
        origin: ORIGIN,
      }),
    );
  });
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("ok");

  await advanceHandshakeTimeout();
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("ok");
  expect(screen.queryByText(/暂不支持/)).toBeNull();
});

test("无深链的浏览态：时限不过渡 rejected（浏览照常，不打扰）", async () => {
  vi.useFakeTimers();
  mount(true);
  await advanceHandshakeTimeout();
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("pending");
  expect(screen.queryByText(/暂不支持/)).toBeNull();
});

test("跨源 hello 不放行：假来源不建立握手（origin 白名单仍生效）", async () => {
  vi.useFakeTimers();
  mount(true);
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
