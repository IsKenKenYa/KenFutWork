import { describe, expect, it } from "vitest";
import type { CuRaster } from "./executor.js";
import {
  helperCoordinate,
  helperElementPoint,
  toHelperKeyRequest,
} from "./executor-helper.js";

it("元素位置、身份或窗口变化后拒绝发送输入", () => {
  const before: Parameters<typeof helperElementPoint>[0] = {
    root: { role: "button", title: "打开" },
    positions: new Map([[0, { x: 20, y: 30, width: 40, height: 20 }]]),
    windowBounds: [10, 10, 200, 200],
  };
  expect(helperElementPoint(before, before, 0)).toEqual({ x: 40, y: 40 });
  for (const after of [
    { ...before, root: { role: "button", title: "删除" } },
    {
      ...before,
      positions: new Map([[0, { x: 20, y: 90, width: 40, height: 20 }]]),
    },
    { ...before, positions: new Map() },
  ]) {
    expect(() => helperElementPoint(before, after, 0)).toThrow(
      expect.objectContaining({ code: "element_stale", actionSent: false }),
    );
  }
  expect(() => helperElementPoint(before, before, 0, { role: "link" })).toThrow(
    expect.objectContaining({ code: "element_stale" }),
  );
});

it("只将当前目标窗口的有效截图坐标换算成屏幕坐标", () => {
  const window = {
    pid: 42,
    windowId: 7,
    title: "测试窗口",
    layer: 0,
    onScreen: true,
    bounds: { x: 100, y: 200, width: 800, height: 600 },
  };
  const raster: Pick<
    CuRaster,
    "binding" | "bounds" | "frameId" | "width" | "height"
  > = {
    binding: "helper:42:7",
    frameId: "frame",
    bounds: [100, 200, 800, 600],
    width: 400,
    height: 300,
  };
  const target = {
    kind: "coordinate" as const,
    frameId: "frame",
    x: 10,
    y: 20,
  };
  expect(helperCoordinate(window, raster, target)).toEqual({ x: 120, y: 240 });
  for (const changed of [
    { ...window, windowId: 8 },
    { ...window, bounds: { ...window.bounds, x: 120 } },
    { ...window, bounds: { ...window.bounds, width: 900 } },
  ]) {
    expect(() => helperCoordinate(changed, raster, target)).toThrow(
      expect.objectContaining({ code: "element_stale", actionSent: false }),
    );
  }
  expect(() => helperCoordinate(window, raster, { ...target, y: 300 })).toThrow(
    expect.objectContaining({ code: "invalid_target", actionSent: false }),
  );
});

describe("Helper 按键组合", () => {
  it("把工具数组当成一个组合键而不是逐键发送", () => {
    expect(toHelperKeyRequest(["command", "a"])).toEqual({
      key: "a",
      modifiers: ["cmd"],
    });
    expect(toHelperKeyRequest(["⌘", "f"])).toEqual({
      key: "f",
      modifiers: ["cmd"],
    });
    expect(toHelperKeyRequest(["ctrl", "shift", "s"])).toEqual({
      key: "s",
      modifiers: ["control", "shift"],
    });
    expect(toHelperKeyRequest(["Enter"])).toEqual({
      key: "enter",
      modifiers: [],
    });
    expect(toHelperKeyRequest(["command+a"])).toEqual({
      key: "a",
      modifiers: ["cmd"],
    });
    expect(toHelperKeyRequest(["command", "+"])).toEqual({
      key: "+",
      modifiers: ["cmd"],
    });
  });

  it("拒绝未知修饰键和空组合", () => {
    expect(() => toHelperKeyRequest(["hyper", "a"])).toThrow("不支持的修饰键");
    expect(() => toHelperKeyRequest([])).toThrow("按键组合不能为空");
  });
});
