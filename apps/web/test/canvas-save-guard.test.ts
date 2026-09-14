import { describe, expect, it } from "vitest";

import { shouldRefuseEmptySave } from "../src/lib/canvas-save-guard";

/**
 * 回归（GUI 全流程实测）：画布页挂载后会发出一次空场景 PUT（埋点抓到 107 字节），
 * 而保存是整表替换——服务端已有内容时这一次会把画布清空（实测发生过：7 个元素被
 * 103 字节空内容覆盖）。卸载前 flush 本就有这条判定，防抖自动保存漏了，空保存正是
 * 从后者漏出去的；现在两条路径共用这个纯函数。
 */
describe("画布空场景覆盖护栏", () => {
  it("服务端已有内容 + 本次要写空 → 拒绝", () => {
    expect(shouldRefuseEmptySave({ incomingCount: 0, loadedCount: 7 })).toBe(
      true,
    );
    expect(shouldRefuseEmptySave({ incomingCount: 0, loadedCount: 1 })).toBe(
      true,
    );
  });

  it("本次有内容 → 照常保存（无论服务端基线）", () => {
    expect(shouldRefuseEmptySave({ incomingCount: 1, loadedCount: 0 })).toBe(
      false,
    );
    expect(shouldRefuseEmptySave({ incomingCount: 3, loadedCount: 7 })).toBe(
      false,
    );
  });

  it("服务端本来就是空的 + 本次仍空 → 不拦（没有东西可丢）", () => {
    expect(shouldRefuseEmptySave({ incomingCount: 0, loadedCount: 0 })).toBe(
      false,
    );
  });
});
