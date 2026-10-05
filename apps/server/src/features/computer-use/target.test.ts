import { describe, expect, it } from "vitest";

import {
  CuTargetError,
  parseAppRef,
  parseTarget,
  validateTarget,
} from "./target.js";

describe("parseTarget（动作目标解析）", () => {
  it("元素索引形态 {type:'element', index}", () => {
    expect(parseTarget({ type: "element", index: 11 })).toEqual({
      kind: "element",
      index: 11,
    });
  });

  it("坐标形态 {type:'coordinate', x, y}（整数化）", () => {
    expect(parseTarget({ type: "coordinate", x: 115, y: 640 })).toEqual({
      kind: "coordinate",
      x: 115,
      y: 640,
    });
    expect(parseTarget({ type: "coordinate", x: 115.7, y: 640.2 })).toEqual({
      kind: "coordinate",
      x: 115,
      y: 640,
    });
  });

  it("非法形态显式报错（不猜、不兜底）", () => {
    expect(() => parseTarget(null)).toThrow(CuTargetError);
    expect(() => parseTarget({ type: "element" })).toThrow(/index/);
    expect(() => parseTarget({ type: "coordinate", x: -3, y: 10 })).toThrow(
      /非负/,
    );
    expect(() => parseTarget({ type: "coordinate", x: 1 })).toThrow(/y/);
    expect(() => parseTarget("11")).toThrow(/element|coordinate/);
    expect(() => parseTarget(11)).toThrow(/element|coordinate/);
  });
});

describe("parseAppRef（应用引用）", () => {
  it("裸字符串按 bundle_id 读；对象形态原样", () => {
    expect(parseAppRef("com.apple.calculator")).toEqual({
      bundleId: "com.apple.calculator",
    });
    expect(parseAppRef({ name: "计算器" })).toEqual({ name: "计算器" });
    expect(parseAppRef({ pid: 24231, windowId: 6363 })).toEqual({
      pid: 24231,
      windowId: 6363,
    });
  });

  it("非法输入报错", () => {
    expect(() => parseAppRef(123)).toThrow(CuTargetError);
    expect(() => parseAppRef({})).toThrow(/name|bundle|pid/);
  });

  it.each([
    { name: "" },
    { name: "  " },
    { pid: 0 },
    { pid: -1 },
    { pid: 1.5 },
    { pid: Number.NaN },
    { pid: Number.POSITIVE_INFINITY },
    { pid: 1, windowId: -1 },
    { pid: 1, windowId: 0.5 },
    { displayId: "" },
    { displayId: "3", pid: 1 },
  ])("拒绝无效或混用引用 %j", (input) => {
    expect(() => parseAppRef(input)).toThrow(CuTargetError);
  });

  it("显示器引用独立于应用，坐标解析保留来源帧", () => {
    expect(parseAppRef({ displayId: "3" })).toEqual({ displayId: "3" });
    expect(
      parseTarget({ type: "coordinate", x: 10, y: 20, frameId: "frame-9" }),
    ).toEqual({ kind: "coordinate", x: 10, y: 20, frameId: "frame-9" });
    expect(() =>
      parseTarget({ type: "coordinate", x: 10, y: 20, frameId: "" }),
    ).toThrow(CuTargetError);
  });
});

describe("validateTarget（帧绑定与元素存在性）", () => {
  const latest = {
    frameId: "frame-1",
    width: 230,
    height: 408,
    elementIndexes: new Set([0, 1, 2, 11]),
  };

  it("坐标必须引用最新 raster：过期帧 → element_stale", () => {
    const verdict = validateTarget(
      { kind: "coordinate", x: 10, y: 10 },
      { ...latest, frameId: "frame-0" },
      latest,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("element_stale");
      expect(verdict.retry).toBe("reobserve");
    }
  });

  it("坐标越出 raster 边界 → invalid_target（绝不放行猜测）", () => {
    const verdict = validateTarget(
      { kind: "coordinate", x: 9999, y: 10 },
      latest,
      latest,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("invalid_target");
  });

  it("帧内合法坐标放行", () => {
    expect(
      validateTarget({ kind: "coordinate", x: 0, y: 407 }, latest, latest).ok,
    ).toBe(true);
  });

  it("元素索引必须在最新观察树中：缺失 → element_unavailable", () => {
    const verdict = validateTarget(
      { kind: "element", index: 99 },
      latest,
      latest,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("element_unavailable");
  });

  it("树内索引放行（元素寻址不依赖 raster 几何）", () => {
    expect(
      validateTarget({ kind: "element", index: 11 }, latest, latest).ok,
    ).toBe(true);
  });
});
