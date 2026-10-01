import { describe, expect, it } from "vitest";

import { blackFrameRatio, isBlackFrame, planImageInline } from "./budget.js";

function pixels(r: number, g: number, b: number, count: number): Uint8Array {
  const buf = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
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
});

describe("planImageInline（截图内联预算）", () => {
  it("预算内 → 内联 base64", () => {
    const plan = planImageInline({
      base64Length: 1000,
      maxInlineBytes: 200_000,
    });
    expect(plan.inline).toBe(true);
  });

  it("超预算 → 拒绝内联并给原因（不截断图片硬塞）", () => {
    const plan = planImageInline({
      base64Length: 300_000,
      maxInlineBytes: 200_000,
    });
    expect(plan.inline).toBe(false);
    if (!plan.inline) {
      expect(plan.reason).toContain("预算");
    }
  });
});
