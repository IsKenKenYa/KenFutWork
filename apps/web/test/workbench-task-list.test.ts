import { describe, expect, it } from "vitest";

import {
  previewGroup,
  resolveTaskIndicator,
  SESSION_PREVIEW_LIMIT,
} from "../src/lib/workbench-task-list";

describe("侧栏对话列表：图标形态", () => {
  it("在跑恒为转圈（未读标记不会盖掉运行态）", () => {
    expect(resolveTaskIndicator(true, false)).toBe("running");
    expect(resolveTaskIndicator(true, true)).toBe("running");
  });

  it("没在跑：未读实心、已读空心", () => {
    expect(resolveTaskIndicator(false, true)).toBe("unread");
    expect(resolveTaskIndicator(false, false)).toBe("read");
  });
});

describe("侧栏对话列表：分组预览", () => {
  const items = Array.from({ length: 8 }, (_, i) => i);

  it("超过上限且未展开：只给前 N 条 + 剩余条数", () => {
    const { visible, hiddenCount } = previewGroup(items, false);
    expect(visible).toHaveLength(SESSION_PREVIEW_LIMIT);
    expect(visible).toEqual([0, 1, 2, 3, 4]);
    expect(hiddenCount).toBe(8 - SESSION_PREVIEW_LIMIT);
  });

  it("展开后全部显示且不再提示隐藏条数", () => {
    const { visible, hiddenCount } = previewGroup(items, true);
    expect(visible).toHaveLength(8);
    expect(hiddenCount).toBe(0);
  });

  it("边界：恰好等于上限、少于上限、空列表都不出「显示更多」", () => {
    const exact = Array.from({ length: SESSION_PREVIEW_LIMIT }, (_, i) => i);
    expect(previewGroup(exact, false)).toEqual({
      visible: exact,
      hiddenCount: 0,
    });
    expect(previewGroup([1, 2], false).hiddenCount).toBe(0);
    expect(previewGroup([], false)).toEqual({ visible: [], hiddenCount: 0 });
  });
});
