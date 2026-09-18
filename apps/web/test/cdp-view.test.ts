// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  isRemoteKeyEvent,
  modifiersOf,
  streamSrc,
  textToForward,
  toViewportPoint,
} from "../src/lib/cdp-view";

/**
 * 面板实时画面的**坐标与键盘换算**（纯逻辑）。
 *
 * 这两件事错了的后果都很隐蔽：坐标错一点就点在旁边（页面没反应），键盘判断错了会往页面里
 * 打字（比如把 Ctrl+V 变成字面量 "v"）——都只能靠单测钉住。
 */
describe("画面流地址", () => {
  it("票据进 query（`<img>` 发不了登录头）；已有末尾斜杠不重复拼", () => {
    expect(streamSrc("http://127.0.0.1:3001", "abc")).toBe(
      "http://127.0.0.1:3001/api/browser/cdp/stream?ticket=abc",
    );
    expect(streamSrc("http://127.0.0.1:3001/", "a b/c")).toBe(
      "http://127.0.0.1:3001/api/browser/cdp/stream?ticket=a%20b%2Fc",
    );
  });
});

describe("显示坐标 → 视口坐标", () => {
  const viewport = { width: 1000, height: 500 };

  it("没有缩放时按位移换算", () => {
    const rect = { left: 100, top: 50, width: 1000, height: 500 };
    expect(toViewportPoint(rect, { x: 200, y: 100 }, viewport)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("面板缩小显示（窗口比例 50%）时按比例放大回视口坐标", () => {
    // 视口 1000×500 在面板里只占 500×250
    const rect = { left: 10, top: 20, width: 500, height: 250 };
    expect(toViewportPoint(rect, { x: 260, y: 145 }, viewport)).toEqual({
      x: 500,
      y: 250,
    });
  });

  it("落在画面外的点夹到边界内（越界坐标 CDP 直接丢，夹一下至少有反应）", () => {
    const rect = { left: 0, top: 0, width: 500, height: 250 };
    expect(toViewportPoint(rect, { x: -40, y: 900 }, viewport)).toEqual({
      x: 0,
      y: 500,
    });
  });

  it("显示盒尺寸为 0（还没布局）时不炸，退回 1:1", () => {
    const rect = { left: 0, top: 0, width: 0, height: 0 };
    expect(toViewportPoint(rect, { x: 12, y: 34 }, viewport)).toEqual({
      x: 12,
      y: 34,
    });
  });
});

describe("修饰键位掩码", () => {
  it("Alt=1 / Ctrl=2 / Meta=4 / Shift=8，可叠加", () => {
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(0);
    expect(
      modifiersOf({
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(1);
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe(2);
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe(4);
    expect(
      modifiersOf({
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe(8);
    expect(
      modifiersOf({
        altKey: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe(15);
  });
});

describe("哪些按键当按键转发（其余走文本）", () => {
  it("有名字的键当按键（含方向键、退格、Tab、Enter）", () => {
    for (const key of ["Enter", "ArrowUp", "Backspace", "Tab", "Escape"]) {
      expect(isRemoteKeyEvent({ key })).toBe(true);
    }
  });

  it("可打印字符走文本（含空格与中文）", () => {
    for (const key of ["a", "A", " ", "中"]) {
      expect(isRemoteKeyEvent({ key })).toBe(false);
    }
  });

  it("输入法合成中与合成中间态的键都不转发", () => {
    expect(isRemoteKeyEvent({ key: "Enter", composing: true })).toBe(false);
    for (const key of ["Process", "Unidentified", "Dead"]) {
      expect(isRemoteKeyEvent({ key })).toBe(false);
    }
  });
});

describe("输入框里这次输入要转发什么文本", () => {
  it("合成中不转发（那是拼音串，不是结果）", () => {
    expect(textToForward({ data: "zhong", isComposing: true })).toBeNull();
  });

  it("合成结束后的最终结果要转发", () => {
    expect(textToForward({ data: "中", isComposing: false })).toBe("中");
  });

  it("空输入（如退格）不转发为文本——退格另有按键那条路", () => {
    expect(textToForward({ data: null, isComposing: false })).toBeNull();
    expect(textToForward({ data: "", isComposing: false })).toBeNull();
  });
});
