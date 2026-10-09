// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlowCanvasFrame } from "../src/components/workbench/flow-canvas-frame";

/**
 * FlowCanvasFrame：宿主侧 `ff-embed/v1` 握手（本地实例身份缝的前端半边）。
 *
 * 锁四件事：
 *  ① flow iframe 发 `hello` → 宿主回 `hello-ack`，随后把本机接入换到的**一次性
 *     身份票据**以 `identity` 注入（flow 只交给它自己的网关去宿主验签，前端不解析）；
 *  ② origin 不在白名单（= frontendUrl 的 origin）→ 一条都不回（安全边界 §3.3）；
 *  ③ `ready` 之后握手提示消失；地址非法时不渲染 iframe 而是给出可读原因；
 *  ④ 换票失败 → 不发 identity（flow 侧按可读原因降级，不拿假身份硬握）。
 */

const FLOW_ORIGIN = "http://127.0.0.1:8080";

function dispatchFromFlow(data: unknown, origin = FLOW_ORIGIN) {
  window.dispatchEvent(new MessageEvent("message", { origin, data }));
}

function frameWindow(): Window {
  const frame = screen.getByTitle("Flow 工作流画布") as HTMLIFrameElement;
  return frame.contentWindow as Window;
}

/** 桩：身份票据端点的两种结果（成功给 token / 失败给非 2xx）。 */
function stubTicket(token: string | null, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      token === null
        ? new Response("{}", { status })
        : Response.json({
            token,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlowCanvasFrame（ff-embed 宿主握手）", () => {
  it("hello → 先回 hello-ack，再注入换来的身份票据（打一次性票据端点，targetOrigin 是 flow origin）", async () => {
    stubTicket("ticket-1");
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} />);
    const postMessage = vi.spyOn(frameWindow(), "postMessage");

    dispatchFromFlow({ type: "ff-embed/hello", version: "v1" });

    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { type: "ff-embed/hello-ack", version: "v1" },
      FLOW_ORIGIN,
    );
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { type: "ff-embed/identity", version: "v1", hostToken: "ticket-1" },
        FLOW_ORIGIN,
      );
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/flow/host/identity-ticket"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("换票失败 → 只回 hello-ack，不发 identity（flow 侧会按可读原因降级）", async () => {
    stubTicket(null, 503);
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} />);
    const postMessage = vi.spyOn(frameWindow(), "postMessage");

    dispatchFromFlow({ type: "ff-embed/hello", version: "v1" });

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    // 等换票 promise 落定一轮：确认没有后手 identity
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "ff-embed/hello-ack", version: "v1" },
      FLOW_ORIGIN,
    );
  });

  it("origin 不在白名单 → 静默丢弃，不回消息也不换票", () => {
    stubTicket("ticket-1");
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} />);
    const postMessage = vi.spyOn(frameWindow(), "postMessage");

    dispatchFromFlow(
      { type: "ff-embed/hello", version: "v1" },
      "http://evil.example",
    );

    expect(postMessage).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("iframe 未加载完成 → 显示全站同款品牌加载屏（logo 动画，不白屏）；load 后出现握手提示", () => {
    stubTicket("ticket-1");
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} />);
    // 品牌加载屏（与画布/登录页同一份 LoadingScreen）：logo 图 + 渐隐的三点
    expect(screen.getByAltText("KenFutWork")).toBeInTheDocument();
    expect(screen.queryByText("正在与 flow 画布握手…")).not.toBeInTheDocument();

    fireEvent.load(screen.getByTitle("Flow 工作流画布"));

    expect(screen.queryByAltText("KenFutWork")).not.toBeInTheDocument();
    expect(screen.getByText("正在与 flow 画布握手…")).toBeInTheDocument();
  });

  it("ready → 握手提示消失", async () => {
    stubTicket("ticket-1");
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} />);
    fireEvent.load(screen.getByTitle("Flow 工作流画布"));
    expect(screen.getByText("正在与 flow 画布握手…")).toBeInTheDocument();

    dispatchFromFlow({ type: "ff-embed/ready", version: "v1" });

    expect(
      await screen.findByText("正在与 flow 画布握手…"),
    ).not.toBeInTheDocument();
  });

  it("frontendUrl 非法 → 不渲染 iframe，给出指向环境变量的可读原因", () => {
    render(<FlowCanvasFrame frontendUrl="不是地址" />);
    expect(screen.queryByTitle("Flow 工作流画布")).not.toBeInTheDocument();
    expect(
      screen.getByText(/KENFUTWORK_FLOW_FRONTEND_URL/),
    ).toBeInTheDocument();
  });
});
