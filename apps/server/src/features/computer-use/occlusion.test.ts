import { describe, expect, it } from "vitest";

import {
  type CuWindowStackRow,
  coverageRatio,
  pickOccludingWindow,
} from "./occlusion.js";

const TARGET_BOUNDS: [number, number, number, number] = [100, 100, 800, 600];

function row(overrides: Partial<CuWindowStackRow> = {}): CuWindowStackRow {
  return {
    pid: 900,
    windowId: 1,
    layer: 0,
    alpha: 1,
    bounds: [0, 0, 10, 10],
    name: null,
    ...overrides,
  };
}

const target = {
  pid: 42,
  windowId: 7,
  bounds: TARGET_BOUNDS,
};

describe("coverageRatio", () => {
  it("完全覆盖 → 1；不相交 → 0", () => {
    expect(coverageRatio(TARGET_BOUNDS, TARGET_BOUNDS)).toBe(1);
    expect(coverageRatio([0, 0, 10, 10], TARGET_BOUNDS)).toBe(0);
  });

  it("四分之一覆盖按目标面积计比例", () => {
    expect(coverageRatio([100, 100, 400, 300], TARGET_BOUNDS)).toBeCloseTo(
      0.25,
      5,
    );
  });

  it("目标面积非法（0 宽/高）→ 0，不产生 NaN", () => {
    expect(coverageRatio([0, 0, 100, 100], [0, 0, 0, 0])).toBe(0);
  });
});

describe("pickOccludingWindow（截图前的遮挡判定）", () => {
  it("目标窗口在最前 → 可截", () => {
    const verdict = pickOccludingWindow(
      [row({ pid: 42, windowId: 7, bounds: TARGET_BOUNDS }), row()],
      target,
    );
    expect(verdict).toEqual({ occluded: false });
  });

  it("前方有同层窗口盖住目标 → 报 covered 并给出遮挡方", () => {
    const blocker = row({
      pid: 7,
      windowId: 3,
      bounds: [90, 90, 500, 500],
      name: "聊天窗口",
    });
    const verdict = pickOccludingWindow(
      [blocker, row({ pid: 42, windowId: 7, bounds: TARGET_BOUNDS })],
      target,
    );
    expect(verdict.occluded).toBe(true);
    if (verdict.occluded) {
      expect(verdict.reason).toBe("covered");
      expect(verdict.blocker).toBe(blocker);
    }
  });

  it("只压到 1% 边缘（阴影/贴边）→ 不判遮挡", () => {
    const verdict = pickOccludingWindow(
      [
        row({ bounds: [100, 100, 8, 600] }),
        row({ pid: 42, windowId: 7, bounds: TARGET_BOUNDS }),
      ],
      target,
    );
    expect(verdict).toEqual({ occluded: false });
  });

  it("更高层窗口（菜单/Dock）与全透明窗口不算遮挡", () => {
    const verdict = pickOccludingWindow(
      [
        row({ layer: 25, bounds: TARGET_BOUNDS }),
        row({ alpha: 0, bounds: TARGET_BOUNDS }),
        row({ pid: 42, windowId: 7, bounds: TARGET_BOUNDS }),
      ],
      target,
    );
    expect(verdict).toEqual({ occluded: false });
  });

  it("目标在目标之后的窗口（物理上盖不住）→ 不判遮挡", () => {
    const verdict = pickOccludingWindow(
      [
        row({ pid: 42, windowId: 7, bounds: TARGET_BOUNDS }),
        row({ bounds: TARGET_BOUNDS }),
      ],
      target,
    );
    expect(verdict).toEqual({ occluded: false });
  });

  it("目标不在屏上（最小化/别的空间）→ not_on_screen", () => {
    const verdict = pickOccludingWindow([row()], target);
    expect(verdict).toEqual({
      occluded: true,
      reason: "not_on_screen",
      blocker: null,
    });
  });

  it("副屏负原点坐标照常判定", () => {
    const negative: [number, number, number, number] = [-1400, 120, 800, 600];
    const verdict = pickOccludingWindow(
      [
        row({ bounds: [-1450, 100, 400, 400] }),
        row({ pid: 42, windowId: 7, bounds: negative }),
      ],
      { pid: 42, windowId: 7, bounds: negative },
    );
    expect(verdict.occluded).toBe(true);
  });

  it("同 pid 的其它窗口（面板/抽屉）也算遮挡", () => {
    const verdict = pickOccludingWindow(
      [
        row({ pid: 42, windowId: 9, bounds: [200, 200, 300, 300] }),
        row({ pid: 42, windowId: 7, bounds: TARGET_BOUNDS }),
      ],
      target,
    );
    expect(verdict.occluded).toBe(true);
  });
});
