import { describe, expect, it } from "vitest";

import { shouldRefuseEmptySave } from "../src/lib/canvas-save-guard";

/**
 * 回归（GUI 全流程实测）：画布保存是**整表替换**，「写空」等于把服务端内容删光。
 * 两次实测教训：
 * ① 挂载期 Excalidraw 先回调一次空列表（埋点抓到 107 字节的空场景 PUT），把刚画好并
 *    已落库的内容覆盖掉——当时只挡了「本会话挂载时非空」这一半；
 * ② 只挡那一半不够：同一画布在工作台 iframe 与本页各开一份，iframe 那份的场景**从来就是
 *    空的**（`loadedCount === 0`），它因焦点变化发出的空保存照样把另一份的作品清空。
 * 所以判定收成「空内容一律不写」，两条写路径（防抖自动保存 / 卸载前 flush）共用。
 */
describe("画布空场景覆盖护栏", () => {
  it("本次要写空 → 一律拒绝（无论本会话挂载时是否非空）", () => {
    expect(shouldRefuseEmptySave({ incomingCount: 0 })).toBe(true);
  });

  it("本次有内容 → 照常保存", () => {
    expect(shouldRefuseEmptySave({ incomingCount: 1 })).toBe(false);
    expect(shouldRefuseEmptySave({ incomingCount: 7 })).toBe(false);
  });
});
