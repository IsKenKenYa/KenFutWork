import { describe, expect, it } from "vitest";

import {
  closeTab,
  pruneTabs,
  tabsStorageKey,
  upsertTab,
  type ChatTab,
} from "../src/lib/chat-tabs";

const tab = (id: string, title = `会话 ${id}`): ChatTab => ({
  sessionId: id,
  title,
});

/**
 * 右侧面板的对话标签页（用户要的形态：每个打开的历史对话一个标签，可多个、可关闭、
 * 左对齐；点历史对话＝新开一个标签而不是顶掉当前）。
 */
describe("对话标签页", () => {
  it("打开新对话 → 追加；重复打开 → 原地更新标题，不新增", () => {
    const one = upsertTab([], tab("a"));
    expect(one.map((t) => t.sessionId)).toEqual(["a"]);

    const two = upsertTab(one, tab("b"));
    expect(two.map((t) => t.sessionId)).toEqual(["a", "b"]);

    // 会话自动改标题：标签标题跟上，位置不变
    const renamed = upsertTab(two, tab("a", "新标题"));
    expect(renamed.map((t) => t.title)).toEqual(["新标题", "会话 b"]);

    // 标题没变 → 原引用（不触发重渲染/写盘）
    expect(upsertTab(renamed, tab("a", "新标题"))).toBe(renamed);
  });

  it("关闭非当前标签 → 当前标签不变", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { tabs: rest, nextActiveId } = closeTab(tabs, "b", "c");
    expect(rest.map((t) => t.sessionId)).toEqual(["a", "c"]);
    expect(nextActiveId).toBe("c");
  });

  it("关闭当前标签 → 右邻优先、其次左邻，全关光则无当前", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(closeTab(tabs, "b", "b")).toEqual({
      tabs: [tab("a"), tab("c")],
      nextActiveId: "c",
    });
    expect(closeTab(tabs, "c", "c").nextActiveId).toBe("b");
    expect(closeTab([tab("a")], "a", "a")).toEqual({
      tabs: [],
      nextActiveId: null,
    });
  });

  it("关闭不存在的标签 → 原样返回", () => {
    const tabs = [tab("a")];
    expect(closeTab(tabs, "zzz", "a")).toEqual({ tabs, nextActiveId: "a" });
  });

  it("清掉已被删除的会话", () => {
    const tabs = [tab("a"), tab("b")];
    expect(pruneTabs(tabs, ["a"]).map((t) => t.sessionId)).toEqual(["a"]);
    expect(pruneTabs(tabs, ["a", "b"])).toBe(tabs);
  });

  it("标签按画布分开存", () => {
    expect(tabsStorageKey("canvas-1")).toBe("chat-open-tabs:canvas-1");
    expect(tabsStorageKey("canvas-2")).not.toBe(tabsStorageKey("canvas-1"));
  });

  it("标签有上限，超出丢最旧", () => {
    let tabs: ChatTab[] = [];
    for (let i = 0; i < 16; i += 1) tabs = upsertTab(tabs, tab(`s${i}`));
    expect(tabs).toHaveLength(12);
    expect(tabs[0]!.sessionId).toBe("s4");
  });
});
