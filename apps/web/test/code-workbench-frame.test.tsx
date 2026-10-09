import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  // 本仓 vitest 未开 globals，Testing Library 的自动清理不会生效：手动清，
  // 否则上一条用例的组件留在 body 里，getByRole 会命中多个
  cleanup();
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

it("本地实例弹窗带语音设置段：Code 模式就地调语音，cookie 接入无令牌头", async () => {
  const calls: Array<{ path: string; headers: unknown }> = [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, headers: init?.headers });
      if (path.includes("/api/voice/settings"))
        return json({
          settings: {
            mode: "transcribe",
            listen: null,
            think: null,
            speak: null,
            speakReplies: false,
          },
        });
      if (path.includes("/api/voice/models")) return json({ models: [] });
      if (path.includes("/api/voice/diagnose")) return json({ report: null });
      if (path.includes("/api/instance/data-location"))
        return json({ dataDir: "/data", canMove: false });
      if (path.includes("/api/local-access/clients"))
        return json({ clients: [] });
      if (path.includes("/api/instance/settings"))
        return json({ settings: { terminalShell: "auto", defaultModel: "" } });
      return new Response("not found", { status: 404 });
    }),
  );
  render(<CodeWorkbenchFrame onModeChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "本地实例" }));
  // 语音段渲染出来（设置页同一组件），设置与模型目录都实际取数
  expect(await screen.findByRole("heading", { name: "语音" })).toBeTruthy();
  await waitFor(() =>
    expect(calls.some((call) => call.path.includes("/api/voice/settings"))).toBe(
      true,
    ),
  );
  await waitFor(() =>
    expect(calls.some((call) => call.path.includes("/api/voice/models"))).toBe(
      true,
    ),
  );
  // cookie 接入（无令牌）：语音设置请求不带 Authorization
  const voiceCall = calls.find((call) =>
    call.path.includes("/api/voice/settings"),
  );
  expect(JSON.stringify(voiceCall?.headers ?? {})).not.toContain(
    "Authorization",
  );
});
