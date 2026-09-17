import { describe, expect, it } from "vitest";

import {
  type ChatTab,
  closeTab,
  pruneTabs,
  tabsStorageKey,
  upsertTab,
} from "../src/lib/chat-tabs";

const chat = (id: string, title = `会话 ${id}`): ChatTab => ({
  kind: "chat",
  id,
  title,
});
const view = (kind: "layers" | "files"): ChatTab => ({
  kind,
  id: kind,
  title: kind === "layers" ? "图层" : "生成文件",
});

/**
 * 右侧面板的标签页：对话标签（每个打开的历史对话一个）＋ 视图标签（图层 / 生成文件，
 * 点对应按钮就开一个）。用户要的形态：可多开、可关闭、左对齐、刷新后仍在。
 */
describe("面板标签页", () => {
  it("打开新对话 → 追加；重复打开 → 原地更新标题，不新增", () => {
    const one = upsertTab([], chat("a"));
    expect(one.map((t) => t.id)).toEqual(["a"]);

    const two = upsertTab(one, chat("b"));
    expect(two.map((t) => t.id)).toEqual(["a", "b"]);

    const renamed = upsertTab(two, chat("a", "新标题"));
    expect(renamed.map((t) => t.title)).toEqual(["新标题", "会话 b"]);
    expect(upsertTab(renamed, chat("a", "新标题"))).toBe(renamed);
  });

  it("点「图层」「生成文件」各开一个视图标签，与对话标签并存", () => {
    let tabs = upsertTab([], chat("a"));
    tabs = upsertTab(tabs, view("layers"));
    tabs = upsertTab(tabs, view("files"));
    expect(tabs.map((t) => `${t.kind}:${t.id}`)).toEqual([
      "chat:a",
      "layers:layers",
      "files:files",
    ]);
    // 再点一次不重复开
    expect(upsertTab(tabs, view("layers"))).toBe(tabs);
  });

  it("关闭非当前标签 → 当前标签不变", () => {
    const tabs = [chat("a"), chat("b"), chat("c")];
    const { tabs: rest, nextActiveId } = closeTab(tabs, "b", "chat", "c");
    expect(rest.map((t) => t.id)).toEqual(["a", "c"]);
    expect(nextActiveId).toBe("c");
  });

  it("关闭当前标签 → 右邻优先、其次左邻，全关光则无当前", () => {
    const tabs = [chat("a"), chat("b"), chat("c")];
    expect(closeTab(tabs, "b", "chat", "b")).toEqual({
      tabs: [chat("a"), chat("c")],
      nextActiveId: "c",
    });
    expect(closeTab(tabs, "c", "chat", "c").nextActiveId).toBe("b");
    expect(closeTab([chat("a")], "a", "chat", "a")).toEqual({
      tabs: [],
      nextActiveId: null,
    });
  });

  it("视图标签与对话标签同名不互串（id 相同但 kind 不同）", () => {
    const tabs = [chat("layers"), view("layers")];
    const { tabs: rest } = closeTab(tabs, "layers", "files", "layers");
    expect(rest).toBe(tabs); // 没有 files:layers 这个标签，不应误删
    expect(closeTab(tabs, "layers", "layers", "layers").tabs).toEqual([
      chat("layers"),
    ]);
  });

  it("清掉已删除的会话标签，但保留视图标签", () => {
    const tabs = [chat("a"), view("layers")];
    expect(pruneTabs(tabs, ["a"])).toBe(tabs);
    expect(pruneTabs(tabs, [])).toEqual([view("layers")]);
  });

  it("标签按画布分开存", () => {
    expect(tabsStorageKey("canvas-1")).toBe("chat-open-tabs:canvas-1");
    expect(tabsStorageKey("canvas-2")).not.toBe(tabsStorageKey("canvas-1"));
  });

  it("标签有上限，超出丢最旧", () => {
    let tabs: ChatTab[] = [];
    for (let i = 0; i < 16; i += 1) tabs = upsertTab(tabs, chat(`s${i}`));
    expect(tabs).toHaveLength(12);
    expect(tabs[0]?.id).toBe("s4");
  });
});
