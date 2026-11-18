import { describe, expect, it } from "vitest";

import {
  createViewTicketStore,
  MJPEG_CONTENT_TYPE,
  mjpegPart,
  parseCdpInputEvent,
  samePageUrl,
} from "./view-stream.js";

/**
 * 面板画面流的协议层（票据 / 分帧 / 输入事件形状 / 同页判定）。
 *
 * 这一层全是纯逻辑，但它守的是**真机才会暴露**的几件事：票据会出现在 URL 里（必须短时
 * 且一次性）、MJPEG 必须带 Content-Length（否则帧里的二进制碰巧撞上分隔符就错位）、
 * 以及「已经在这一页就别再导航一次」（重复导航会把面板里的一切刷掉）。
 */
describe("画面流票据（短时 + 一次性）", () => {
  it("取过一次就作废（票据在 URL 里，泄漏窗口要小）", () => {
    const store = createViewTicketStore();
    const ticket = store.mint({ width: 900, height: 600 });
    expect(store.take(ticket)).toEqual({ width: 900, height: 600 });
    expect(store.take(ticket)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("过期后作废；不存在的票据返回 null（不抛）", () => {
    let now = 1_000;
    const store = createViewTicketStore({ ttlMs: 30_000, now: () => now });
    const ticket = store.mint({});
    now += 30_001;
    expect(store.take(ticket)).toBeNull();
    expect(store.take(undefined)).toBeNull();
    expect(store.take("凭空编的")).toBeNull();
  });

  it("mint 时顺手清掉过期的（长期不用的实例不会攒垃圾）", () => {
    let now = 1_000;
    const store = createViewTicketStore({ ttlMs: 10, now: () => now });
    store.mint({});
    store.mint({});
    expect(store.size()).toBe(2);
    now += 100;
    store.mint({});
    expect(store.size()).toBe(1);
  });

  it("每张票据都不同（随机，不按顺序编号）", () => {
    const store = createViewTicketStore();
    const a = store.mint({});
    const b = store.mint({});
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(8);
  });
});

describe("MJPEG 分帧", () => {
  it("带上 Content-Length（帧里撞上分隔符也不会错位）", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const part = mjpegPart(jpeg);
    const text = part.toString("latin1");
    expect(text.startsWith("--kfwframe\r\n")).toBe(true);
    expect(text).toContain("Content-Type: image/jpeg");
    expect(text).toContain(`Content-Length: ${jpeg.length}`);
    expect(text.endsWith("\r\n")).toBe(true);
    // 二进制原样跟在头之后
    expect(
      part.subarray(part.length - jpeg.length - 2, part.length - 2),
    ).toEqual(jpeg);
    expect(MJPEG_CONTENT_TYPE).toContain("boundary=kfwframe");
  });
});

describe("同页判定（面板打开地址时别重复导航）", () => {
  it("忽略 hash 与末尾斜杠；query 不同算不同页", () => {
    expect(samePageUrl("https://a.com/x", "https://a.com/x")).toBe(true);
    expect(samePageUrl("https://a.com/x/", "https://a.com/x")).toBe(true);
    expect(samePageUrl("https://a.com/x#top", "https://a.com/x")).toBe(true);
    expect(samePageUrl("https://a.com/x?a=1", "https://a.com/x?a=1")).toBe(
      true,
    );
    expect(samePageUrl("https://a.com/x?a=1", "https://a.com/x?a=2")).toBe(
      false,
    );
    expect(samePageUrl("https://a.com/x", "https://a.com/y")).toBe(false);
    expect(samePageUrl("https://a.com/x", "http://a.com/x")).toBe(false);
  });

  it("空地址不算同一页（受控浏览器还停在 about:blank 时要真的导航过去）", () => {
    expect(samePageUrl("", "https://a.com/x")).toBe(false);
    expect(samePageUrl("about:blank", "https://a.com/x")).toBe(false);
  });
});

describe("输入事件形状校验", () => {
  it("鼠标：坐标必填，按键/位掩码可选；非法形状返回 null", () => {
    expect(
      parseCdpInputEvent({
        type: "mouse",
        action: "pressed",
        x: 1,
        y: 2,
        button: "right",
        buttons: 2,
      }),
    ).toEqual({
      type: "mouse",
      action: "pressed",
      x: 1,
      y: 2,
      button: "right",
      buttons: 2,
    });
    expect(
      parseCdpInputEvent({ type: "mouse", action: "moved", x: 1, y: 2 }),
    ).toEqual({ type: "mouse", action: "moved", x: 1, y: 2 });
    expect(
      parseCdpInputEvent({ type: "mouse", action: "跳", x: 1, y: 2 }),
    ).toBeNull();
    expect(
      parseCdpInputEvent({ type: "mouse", action: "moved", x: 1 }),
    ).toBeNull();
    expect(
      parseCdpInputEvent({ type: "mouse", action: "moved", x: NaN, y: 2 }),
    ).toBeNull();
  });

  it("滚轮 / 按键 / 文本：缺关键字段一律 null", () => {
    expect(
      parseCdpInputEvent({ type: "wheel", x: 0, y: 0, deltaY: 10 }),
    ).toEqual({
      type: "wheel",
      x: 0,
      y: 0,
      deltaY: 10,
    });
    expect(parseCdpInputEvent({ type: "wheel", x: 0 })).toBeNull();
    expect(
      parseCdpInputEvent({ type: "key", key: "Enter", modifiers: 8 }),
    ).toEqual({
      type: "key",
      key: "Enter",
      modifiers: 8,
    });
    expect(parseCdpInputEvent({ type: "key", key: "" })).toBeNull();
    expect(parseCdpInputEvent({ type: "text", text: "中文" })).toEqual({
      type: "text",
      text: "中文",
    });
    expect(parseCdpInputEvent({ type: "text", text: "" })).toBeNull();
    expect(parseCdpInputEvent(null)).toBeNull();
    expect(parseCdpInputEvent("mouse")).toBeNull();
    expect(parseCdpInputEvent({ type: "未知" })).toBeNull();
  });
});
