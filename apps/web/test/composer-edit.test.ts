import { describe, expect, it } from "vitest";

import {
  COMPOSER_MENU_ITEMS,
  deleteRange,
  EMPTY_TEXT_HISTORY,
  normalizeRange,
  rangeText,
  recordHistory,
  redoHistory,
  replaceRange,
  selectAllRange,
  undoHistory,
} from "../src/lib/composer-edit.js";

/**
 * 回归背景：输入框右键要能撤销/重做/剪切/复制/粘贴/删除/全选
 * （应用内浏览器不弹原生编辑菜单）。区间编辑与历史都在这里锁死。
 */

/** 取出可空的历史结果；为空说明这一步不该返回空，直接报错。 */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what}：期望返回历史，实际为 ${String(value)}`);
  }
  return value;
}

describe("输入框区间编辑", () => {
  it("区间夹取：越界与反向选区都被规范化", () => {
    expect(normalizeRange("abc", { start: -5, end: 99 })).toEqual({
      start: 0,
      end: 3,
    });
    // 反向选区（从右往左选）
    expect(normalizeRange("abcdef", { start: 4, end: 2 })).toEqual({
      start: 2,
      end: 4,
    });
  });

  it("替换/删除/取文本/全选", () => {
    expect(replaceRange("hello world", { start: 6, end: 11 }, "there")).toEqual(
      {
        value: "hello there",
        caret: 11,
      },
    );
    expect(deleteRange("hello world", { start: 5, end: 11 })).toEqual({
      value: "hello",
      caret: 5,
    });
    expect(rangeText("hello world", { start: 0, end: 5 })).toBe("hello");
    expect(rangeText("hello", { start: 2, end: 2 })).toBe("");
    expect(selectAllRange("hello")).toEqual({ start: 0, end: 5 });
  });

  it("在光标处插入（空区间）不改动其它文本", () => {
    expect(replaceRange("ab", { start: 1, end: 1 }, "X")).toEqual({
      value: "aXb",
      caret: 2,
    });
  });
});

describe("输入框撤销/重做历史", () => {
  it("首批输入产生一条还原点；撤销后能回到上一个值", () => {
    const history = recordHistory(EMPTY_TEXT_HISTORY, "a", 1000);
    expect(history.past).toEqual(["a"]);
    const undone = undoHistory(history, "ab");
    expect(undone?.value).toBe("a");
    expect(undone?.history.future).toEqual(["ab"]);
  });

  it("连续打字合并为一条（不逐字符撤销）", () => {
    let history = recordHistory(EMPTY_TEXT_HISTORY, "a", 1000);
    history = recordHistory(history, "ab", 1100);
    history = recordHistory(history, "abc", 1200);
    expect(history.past).toEqual(["a"]);
    // 超过合并窗口后另开一条
    history = recordHistory(history, "abcd", 5000);
    expect(history.past).toEqual(["a", "abcd"]);
  });

  it("撤销后再次输入会清空重做栈", () => {
    let history = recordHistory(EMPTY_TEXT_HISTORY, "a", 1000);
    history = recordHistory(history, "ab", 5000);
    const undone = required(undoHistory(history, "abc"), "撤销");
    expect(undone.history.future).toEqual(["abc"]);
    const afterTyping = recordHistory(undone.history, undone.value, 9000);
    expect(afterTyping.future).toEqual([]);
  });

  it("重做：把撤销掉的内容放回来，且可反复撤销/重做", () => {
    let history = recordHistory(EMPTY_TEXT_HISTORY, "a", 1000);
    history = recordHistory(history, "ab", 5000);
    const undone = required(undoHistory(history, "abc"), "撤销");
    const redone = required(redoHistory(undone.history, undone.value), "重做");
    expect(redone.value).toBe("abc");
    const undoneAgain = required(
      undoHistory(redone.history, redone.value),
      "再次撤销",
    );
    expect(undoneAgain.value).toBe("ab");
  });

  it("无可撤销/可重做时返回 null（菜单据此不误报）", () => {
    expect(undoHistory(EMPTY_TEXT_HISTORY, "x")).toBeNull();
    expect(redoHistory(EMPTY_TEXT_HISTORY, "x")).toBeNull();
  });

  it("历史上限生效（只保留最近 N 条）", () => {
    let history = EMPTY_TEXT_HISTORY;
    for (let i = 0; i < 10; i += 1) {
      history = recordHistory(history, `v${i}`, i * 10_000, { limit: 3 });
    }
    expect(history.past).toEqual(["v7", "v8", "v9"]);
  });
});

describe("菜单项", () => {
  it("七项齐备且顺序稳定", () => {
    expect(COMPOSER_MENU_ITEMS.map((item) => item.label)).toEqual([
      "撤销",
      "重做",
      "剪切",
      "复制",
      "粘贴",
      "删除",
      "全选",
    ]);
  });
});
