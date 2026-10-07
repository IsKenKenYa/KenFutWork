// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PANEL_READY_MESSAGE_TYPE,
  PANEL_TOKEN_MESSAGE_TYPE,
  panelTokenTarget,
  PluginPanelOverlay,
} from "../src/lib/plugin-panels";

/**
 * 面板令牌握手（回归：米家面板在真机永远停在「正在获取登录态…」）。
 *
 * 缺陷链（2026-10-07 真机逐层定位）：面板脚本晚于 iframe `load` 才注册好 message 监听
 * （其引导加载是异步的），宿主 onLoad 时递的令牌赶在监听器存在之前到达而丢失，
 * 面板永远等不到令牌。锁住的行为：面板发来「就绪回执」后宿主必须**补递一次令牌**；
 * 来源不是本弹层 iframe 的回执一律不认（不把令牌递给别的窗口）。
 */
afterEach(cleanup);

const PANEL = {
  id: "panel",
  pluginId: "local__mihome",
  title: "米家",
  slot: "sidebar",
  url: "p",
  icon: null,
};

describe("插件面板令牌握手", () => {
  it("收到面板就绪回执后补递令牌（来源必须是本弹层 iframe）", async () => {
    render(
      <PluginPanelOverlay panel={PANEL} accessToken="tok-1" onClose={() => {}} />,
    );
    const frame = (await screen.findByTitle("米家")) as HTMLIFrameElement;
    const contentWindow = frame.contentWindow as Window;
    expect(contentWindow).toBeTruthy();
    const postMessage = vi.spyOn(contentWindow, "postMessage");

    // 伪造来源（别的窗口）的回执：不递
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: PANEL_READY_MESSAGE_TYPE },
      }),
    );
    expect(postMessage).not.toHaveBeenCalled();

    // 本弹层 iframe 的就绪回执：补递令牌到面板 origin
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: PANEL_READY_MESSAGE_TYPE },
        source: contentWindow,
      }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: PANEL_TOKEN_MESSAGE_TYPE, accessToken: "tok-1" },
      panelTokenTarget(PANEL.url, PANEL.pluginId),
    );
  });
});
