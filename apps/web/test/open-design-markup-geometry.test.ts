import { describe, expect, test } from "vitest";
import {
  frameRectToOverlay,
  normalizedToOverlay,
  overlayToNormalized,
  type FrameMetrics,
  type OverlayBox,
} from "../src/components/workbench/zcode/host/openDesignMarkupGeometry.js";

/**
 * 覆盖层 ↔ 那一侧文档的坐标换算。
 * 三个变量同时在场：CSS zoom（体现在 box 尺寸上）、设备视口框、文档内滚动。
 */

const box: OverlayBox = { left: 40, top: 20, width: 800, height: 600 };
/** 内侧视口 400×300（等于 2 倍缩放），文档 400×1200，已向下滚 300。 */
const metrics: FrameMetrics = {
  w: 400,
  h: 1200,
  vw: 400,
  vh: 300,
  sx: 0,
  sy: 300,
};

describe("open-design 覆盖层坐标", () => {
  test("覆盖层点 → 文档归一化：按视口比例换算并补滚动量", () => {
    // 覆盖层 (440,170) = iframe 内 (400,150) 屏幕像素；内侧视口只有一半大 →
    // 内侧 CSS 坐标 (200,75)，再补上已滚的 300 → 文档 (200,375) → /1200 = 0.3125
    expect(overlayToNormalized({ x: 440, y: 170 }, box, metrics)).toEqual([
      0.5, 0.3125,
    ]);
  });

  test("往返一致：归一化再换回来落在原像素", () => {
    for (const [x = 0, y = 0] of [
      [40, 20],
      [440, 170],
      [839.5, 619.25],
    ]) {
      const normalized = overlayToNormalized({ x, y }, box, metrics);
      const back = normalizedToOverlay(
        normalized[0] ?? Number.NaN,
        normalized[1] ?? Number.NaN,
        box,
        metrics,
      );
      expect(back.px).toBeCloseTo(x, 5);
      expect(back.py).toBeCloseTo(y, 5);
    }
  });

  test("越界点夹到 0..1，不产生负比例", () => {
    expect(overlayToNormalized({ x: -100, y: 5000 }, box, metrics)).toEqual([
      0, 1,
    ]);
  });

  test("尺寸还没量到时返回原点，不炸也不 NaN", () => {
    const zero = { ...metrics, vw: 0, vh: 0 };
    expect(Number.isNaN(overlayToNormalized({ x: 1, y: 1 }, box, zero)[0])).toBe(
      false,
    );
    expect(overlayToNormalized({ x: 1, y: 1 }, { ...box, width: 0 }, metrics)).toEqual(
      [0, 0],
    );
  });

  test("元素矩形换算：视口坐标 × 比例 + iframe 偏移", () => {
    const spot = frameRectToOverlay(
      { x: 100, y: 50, w: 200, h: 40 },
      box,
      metrics,
    );
    expect(spot).toEqual({ left: 240, top: 120, width: 400, height: 80 });
  });

  test("锚点失效的文档矩形折算回视口后与实时矩形同一口径", () => {
    const storedDocRect = { x: 100, y: 350, w: 200, h: 40 };
    const asViewport = {
      ...storedDocRect,
      x: storedDocRect.x - metrics.sx,
      y: storedDocRect.y - metrics.sy,
    };
    expect(frameRectToOverlay(asViewport, box, metrics)).toEqual(
      frameRectToOverlay({ x: 100, y: 50, w: 200, h: 40 }, box, metrics),
    );
  });
});
