import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const entryRef = { current: null as unknown };
const lastProjectRef = { current: null as { projectId: string; name: string } | null };
const readinessRef = {
  current: { reachable: true, agentAvailable: true },
};

vi.mock("../src/components/workbench/zcode/host/openDesignHost.js", () => ({
  useOpenDesignEntry: () => entryRef.current,
}));
vi.mock("../src/components/workbench/zcode/host/surfaceApi.js", () => ({
  surfaceJson: async (path: string) =>
    String(path).includes("readiness")
      ? readinessRef.current
      : { project: lastProjectRef.current },
}));

const { OpenDesignPane } = await import(
  "../src/components/workbench/zcode/host/OpenDesignPane.js"
);

const ORIGIN = "http://127.0.0.1:7456";

afterEach(() => {
  cleanup();
  entryRef.current = null;
  lastProjectRef.current = null;
  readinessRef.current = { reachable: true, agentAvailable: true };
});

async function mount(available = true) {
  entryRef.current = available
    ? { available: true, frontendUrl: ORIGIN }
    : { available: false, reason: "未就绪。" };
  const view = render(<OpenDesignPane />);
  // 面板先等「最近项目」落定再挂 iframe，避免先闪一帧首页
  fireEvent.load(await screen.findByTitle("OpenDesign"));
  return view;
}

function paneRoot() {
  return screen.getByTestId("open-design-pane");
}

test("上游回 hello → 握手成立（ok）", async () => {
  await mount();
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

test("跨源 hello 不放行：origin 白名单是第一道闸", async () => {
  await mount();
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

test("形状不明的消息不放行：schema 是第二道闸", async () => {
  await mount();
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

test("上游不回话：画布照常挂载，握手保持 pending（深链已移除，无提示条）", async () => {
  await mount();
  expect(screen.getByTitle("OpenDesign")).toBeTruthy();
  expect(paneRoot().getAttribute("data-od-handshake")).toBe("pending");
  expect(screen.queryByText(/暂不支持/)).toBeNull();
});

test("有最近创建的项目时打开它的项目画布，而不是上游首页", async () => {
  lastProjectRef.current = { projectId: "p-1", name: "订单仪表盘" };
  await mount();
  const frame = screen.getByTitle("OpenDesign");
  expect(frame.getAttribute("src")).toBe(`${ORIGIN}/projects/p-1`);
});

test("没有最近项目时退回上游首页（首次使用仍能创建）", async () => {
  await mount();
  const frame = screen.getByTitle("OpenDesign");
  expect(frame.getAttribute("src")).toBe(ORIGIN);
});

test("上游没有可用设计引擎时，面板说明原因而不是让人对着设置页猜", async () => {
  readinessRef.current = { reachable: true, agentAvailable: false };
  await mount();
  expect(
    screen.getByTestId("open-design-readiness").textContent,
  ).toContain("没有可用的设计引擎");
});
