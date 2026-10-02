import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodeWorkbenchFrame } from "../src/components/workbench/code-workbench-frame";
import { AuthProvider } from "../src/lib/auth-context";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("仅向当前 Code 文档发送宿主配置；原 Design 菜单请求交回模式导航，令牌不进入 URL", async () => {
  localStorage.setItem("kenfutwork.session.token", "private-session-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: {
              id: "actor",
              email: "dev@example.test",
              displayName: "开发者",
            },
            session: {
              token: "private-session-token",
              expiresAt: "2099-01-01T00:00:00Z",
            },
          }),
        ),
    ),
  );
  const navigate = vi.fn();
  render(
    <AuthProvider>
      <CodeWorkbenchFrame onModeChange={navigate} />
    </AuthProvider>,
  );
  const frame = screen.getByTitle("Code 工作台") as HTMLIFrameElement;
  if (!frame.contentWindow) throw new Error("测试 Code 文档未创建");
  const send = vi.spyOn(frame.contentWindow, "postMessage");
  expect(frame.src).not.toContain("private-session-token");
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
        accessToken: "private-session-token",
        user: {
          id: "actor",
          username: "dev@example.test",
          displayName: "开发者",
        },
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
});
