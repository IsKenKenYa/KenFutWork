import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeWorkbenchFrame } from "../src/components/workbench/code-workbench-frame";
import { LOCAL_ACCESS_LOST_EVENT } from "../src/lib/local-access";

vi.mock("../src/lib/local-instance-context", () => ({
  useLocalInstance: () => ({
    instance: { instanceId: "instance", dataDir: "/data" },
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("仅向当前 Code 文档发送宿主配置；原 Design 菜单请求交回模式导航，没有伪账户或接入令牌", async () => {
  const navigate = vi.fn();
  render(<CodeWorkbenchFrame onModeChange={navigate} />);
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("测试 Code 文档未创建");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  expect(frame.src).not.toContain("connect=");
  for (const source of [window, null]) {
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: window.location.origin,
        source,
        data: { type: "kenfutwork:code-ready" },
      }),
    );
  }
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://untrusted.example",
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  expect(send).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-ready" },
    }),
  );
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kenfutwork:code-bootstrap",
        apiBase: window.location.origin,
        user: null,
      }),
      window.location.origin,
    ),
  );
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-navigate", mode: "design" },
    }),
  );
  expect(navigate).toHaveBeenCalledWith("design");
  const lost = vi.fn();
  window.addEventListener(LOCAL_ACCESS_LOST_EVENT, lost);
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: window,
      data: { type: "kenfutwork:code-access-lost" },
    }),
  );
  expect(lost).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: { type: "kenfutwork:code-access-lost" },
    }),
  );
  expect(lost).toHaveBeenCalledOnce();
  window.removeEventListener(LOCAL_ACCESS_LOST_EVENT, lost);
});
