import { describe, expect, it } from "vitest";

import {
  closeTab,
  pruneTabs,
  upsertTab,
  type WorkbenchTab,
} from "../src/lib/workbench-tabs";

const tab = (id: string, name = id): WorkbenchTab => ({
  projectId: id,
  canvasId: `canvas-${id}`,
  name,
});

/**
 * 画布标签的增删与「关掉当前标签后选谁」。
 *
 * 用户给的参照是编辑器里的文件标签（多个文档并排、各带 × ）。这里是它的纯逻辑，
 * 组件只做展示与事件转发。
 */
describe("工作台画布标签", () => {
  it("打开新画布 → 追加到末尾；重复打开 → 原地更新，不产生第二条", () => {
    const one = upsertTab([], tab("a"));
    expect(one.map((t) => t.projectId)).toEqual(["a"]);

    const two = upsertTab(one, tab("b"));
    expect(two.map((t) => t.projectId)).toEqual(["a", "b"]);

    // 重复打开 a：位置不变、不新增
    const again = upsertTab(two, tab("a"));
    expect(again).toBe(two);
  });

  it("项目改名/换画布 → 原地更新字段", () => {
    const tabs = [tab("a", "旧名"), tab("b")];
    const renamed = upsertTab(tabs, tab("a", "新名"));
    expect(renamed.map((t) => t.name)).toEqual(["新名", "b"]);
    expect(renamed[0]!.canvasId).toBe("canvas-a");
  });

  it("关闭非当前标签 → 当前标签不变", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    const { tabs: rest, nextActiveId } = closeTab(tabs, "b", "c");
    expect(rest.map((t) => t.projectId)).toEqual(["a", "c"]);
    expect(nextActiveId).toBe("c");
  });

  it("关闭当前标签 → 右邻优先，其次左邻，全关光则无选中", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    // 关中间：右邻（c）
    expect(closeTab(tabs, "b", "b")).toEqual({
      tabs: [tab("a"), tab("c")],
      nextActiveId: "c",
    });
    // 关最后一个：左邻（a）
    expect(closeTab(tabs, "c", "c").nextActiveId).toBe("b");
    // 关唯一一个：null
    expect(closeTab([tab("a")], "a", "a")).toEqual({
      tabs: [],
      nextActiveId: null,
    });
  });

  it("关闭不存在的标签 → 原样返回", () => {
    const tabs = [tab("a")];
    expect(closeTab(tabs, "zzz", "a")).toEqual({
      tabs,
      nextActiveId: "a",
    });
  });

  it("清掉已不存在的项目（被删/换账号）", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(pruneTabs(tabs, ["a", "c"]).map((t) => t.projectId)).toEqual([
      "a",
      "c",
    ]);
    // 全都在 → 返回原引用，不触发重渲染
    expect(pruneTabs(tabs, ["a", "b", "c"])).toBe(tabs);
  });

  it("标签数量有上限，超出时丢最旧的", () => {
    let tabs: WorkbenchTab[] = [];
    for (let i = 0; i < 25; i += 1) tabs = upsertTab(tabs, tab(`p${i}`));
    expect(tabs).toHaveLength(20);
    expect(tabs[0]!.projectId).toBe("p5");
    expect(tabs.at(-1)!.projectId).toBe("p24");
  });
});
