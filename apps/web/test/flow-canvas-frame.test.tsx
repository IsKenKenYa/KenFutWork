// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlowCanvasFrame } from "../src/components/workbench/flow-canvas-frame";

/**
 * FlowCanvasFrame：宿主侧 `ff-embed/v1` 握手（P2 身份缝的前端半边）。
 *
 * 锁三件事：
 *  ① flow iframe 发 `hello` → 宿主回 `hello-ack` + `identity`（hostToken 给它自己的
 *     网关去验签，前端不解析令牌内容）；
 *  ② origin 不在白名单（= frontendUrl 的 origin）→ 一条都不回（安全边界 §3.3）；
 *  ③ `ready` 之后握手提示消失；地址非法时不渲染 iframe 而是给出可读原因。
 */

const FLOW_ORIGIN = "http://127.0.0.1:8080";

function dispatchFromFlow(data: unknown, origin = FLOW_ORIGIN) {
  window.dispatchEvent(new MessageEvent("message", { origin, data }));
}

function frameWindow(): Window {
  const frame = screen.getByTitle("Flow 工作流画布") as HTMLIFrameElement;
  return frame.contentWindow as Window;
}

afterEach(() => cleanup());

describe("FlowCanvasFrame（ff-embed 宿主握手）", () => {
  it("hello → 依次回 hello-ack 与 identity（hostToken 原样透传，targetOrigin 是 flow origin）", () => {
    const getToken = () => "host-token-1";
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} getToken={getToken} />);
    const postMessage = vi.spyOn(frameWindow(), "postMessage");

    dispatchFromFlow({ type: "ff-embed/hello", version: "v1" });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      { type: "ff-embed/hello-ack", version: "v1" },
      FLOW_ORIGIN,
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      { type: "ff-embed/identity", version: "v1", hostToken: "host-token-1" },
      FLOW_ORIGIN,
    );
  });

  it("hello 时还没有会话令牌 → 只回 hello-ack，不发空 identity（flow 侧会按可读原因降级）", () => {
    render(<FlowCanvasFrame frontendUrl={FLOW_ORIGIN} getToken={() => null} />);
    const postMessage = vi.spyOn(frameWindow(), "postMessage");

    dispatchFromFlow({ type: "ff-embed/hello", version: "v1" });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "ff-embed/hello-ack", version: "v1" },
      FLOW_ORIGIN,
    );
  });

  it("origin 不在白名单 → 静默丢弃，不回任何消息", () => {
    render(
      <FlowCanvasFrame frontendUrl={FLOW_ORIGIN} getToken={() => "tok"} />,
    );
    const postMessage = vi.spyOn(frameWindow(), "postMessage");

    dispatchFromFlow(
      { type: "ff-embed/hello", version: "v1" },
      "http://evil.example",
    );

    expect(postMessage).not.toHaveBeenCalled();
  });

  it("iframe 未加载完成 → 显示画布同款加载层（不白屏）；load 后出现握手提示", () => {
    render(
      <FlowCanvasFrame frontendUrl={FLOW_ORIGIN} getToken={() => "tok"} />,
    );
    expect(screen.getByText("加载工作流…")).toBeInTheDocument();
    expect(screen.queryByText("正在与 flow 画布握手…")).not.toBeInTheDocument();

    fireEvent.load(screen.getByTitle("Flow 工作流画布"));

    expect(screen.queryByText("加载工作流…")).not.toBeInTheDocument();
    expect(screen.getByText("正在与 flow 画布握手…")).toBeInTheDocument();
  });

  it("ready → 握手提示消失", async () => {
    render(
      <FlowCanvasFrame frontendUrl={FLOW_ORIGIN} getToken={() => "tok"} />,
    );
    fireEvent.load(screen.getByTitle("Flow 工作流画布"));
    expect(screen.getByText("正在与 flow 画布握手…")).toBeInTheDocument();

    dispatchFromFlow({ type: "ff-embed/ready", version: "v1" });

    expect(
      await screen.findByText("正在与 flow 画布握手…"),
    ).not.toBeInTheDocument();
  });

  it("frontendUrl 非法 → 不渲染 iframe，给出指向环境变量的可读原因", () => {
    render(<FlowCanvasFrame frontendUrl="不是地址" getToken={() => "tok"} />);
    expect(screen.queryByTitle("Flow 工作流画布")).not.toBeInTheDocument();
    expect(
      screen.getByText(/KENFUTWORK_FLOW_FRONTEND_URL/),
    ).toBeInTheDocument();
  });
});
