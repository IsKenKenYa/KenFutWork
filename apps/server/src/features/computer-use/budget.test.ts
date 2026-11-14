import { describe, expect, it } from "vitest";

import { blackFrameRatio, isBlackFrame } from "./budget.js";

function pixels(r: number, g: number, b: number, count: number): Uint8Array {
  const buf = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

/** pngjs 解码结果恒为 RGBA——接线时按 4 通道采样，不能复用 RGB 的步长。 */
function rgbaPixels(
  r: number,
  g: number,
  b: number,
  a: number,
  count: number,
): Uint8Array {
  const buf = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

describe("isBlackFrame（黑帧检测）", () => {
  it("全黑像素 → 判黑帧（无屏幕录制权限的典型表现）", () => {
    expect(isBlackFrame(pixels(0, 0, 0, 4096))).toBe(true);
  });

  it("真实内容（含非黑像素）→ 非黑帧", () => {
    const mixed = pixels(0, 0, 0, 4000);
    for (let i = 0; i < 96; i++) {
      mixed[i * 3] = 50;
      mixed[i * 3 + 1] = 45;
      mixed[i * 3 + 2] = 45;
    }
    expect(isBlackFrame(mixed)).toBe(false);
  });

  it("空数据 → 判黑帧（fail closed，不冒充有内容）", () => {
    expect(isBlackFrame(new Uint8Array(0))).toBe(true);
  });

  it("blackFrameRatio 输出全黑占比", () => {
    const mixed = pixels(0, 0, 0, 300);
    for (let i = 0; i < 100; i++) {
      mixed[i * 3] = 255;
    }
    // 100/300 非黑 → 全黑占比 2/3
    expect(blackFrameRatio(mixed)).toBeCloseTo(2 / 3, 2);
  });

  it("RGBA 缓冲按 4 通道采样：全黑判黑帧", () => {
    expect(isBlackFrame(rgbaPixels(0, 0, 0, 255, 4096), 4)).toBe(true);
  });

  it("RGBA 缓冲有内容（含透明像素）→ 非黑帧", () => {
    const mixed = rgbaPixels(0, 0, 0, 255, 4000);
    for (let i = 0; i < 96; i++) {
      mixed[i * 4] = 30;
      mixed[i * 4 + 1] = 28;
      mixed[i * 4 + 2] = 26;
    }
    expect(isBlackFrame(mixed, 4)).toBe(false);
  });

  it("RGBA 全黑占比：透明像素仍是黑（alpha 不参与判黑）", () => {
    const half = rgbaPixels(0, 0, 0, 0, 200);
    for (let i = 0; i < 100; i++) {
      half[i * 4] = 200;
    }
    expect(blackFrameRatio(half, 4)).toBeCloseTo(0.5, 2);
  });
});
