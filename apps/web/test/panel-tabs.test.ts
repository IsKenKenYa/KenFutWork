import { describe, expect, it } from "vitest";

import {
  baseName,
  closePanelTab,
  filterPanelTabs,
  makePanelTab,
  openPanelTab,
  type PanelTab,
  panelViewId,
  panelViewLabel,
  relativeOpenedLabel,
} from "@/lib/panel-tabs";

function tab(view: Parameters<typeof makePanelTab>[0], at = 0): PanelTab {
  return makePanelTab(view, at);
}

describe("panel-tabs：编辑器式多标签的顺序与身份", () => {
  it("同一视图重复打开是激活既有标签，不是堆第二个", () => {
    const first = openPanelTab([], null, { kind: "changes" }, 1);
    const again = openPanelTab(
      first.tabs,
      first.activeId,
      { kind: "changes" },
      2,
    );
    expect(again.tabs).toHaveLength(1);
    expect(again.activeId).toBe("changes");
  });

  it("同一文件开两个标签只有路径相同才合并（diff 与 file 是两个视图）", () => {
    const base: PanelTab[] = [];
    const a = openPanelTab(base, null, { kind: "file", path: "src/a.ts" }, 1);
    const b = openPanelTab(
      a.tabs,
      a.activeId,
      { kind: "diff", path: "src/a.ts" },
      2,
    );
    expect(b.tabs.map((t) => t.id)).toEqual(["file:src/a.ts", "diff:src/a.ts"]);
    expect(b.tabs.map((t) => t.label)).toEqual(["a.ts", "a.ts"]);
  });

  it("关掉激活标签时右邻接替", () => {
    const tabs = [
      tab({ kind: "changes" }),
      tab({ kind: "file", path: "a.ts" }),
      tab({ kind: "terminal" }),
    ];
    const closed = closePanelTab(tabs, "file:a.ts", "file:a.ts");
    expect(closed.tabs.map((t) => t.id)).toEqual(["changes", "terminal"]);
    expect(closed.activeId).toBe("terminal");
  });

  it("没有右邻时左邻接替", () => {
    const tabs = [tab({ kind: "changes" }), tab({ kind: "terminal" })];
    const closed = closePanelTab(tabs, "terminal", "terminal");
    expect(closed.activeId).toBe("changes");
  });

  it("关掉非激活标签不影响当前激活视图", () => {
    const tabs = [
      tab({ kind: "changes" }),
      tab({ kind: "file", path: "a.ts" }),
      tab({ kind: "terminal" }),
    ];
    const closed = closePanelTab(tabs, "terminal", "changes");
    expect(closed.tabs.map((t) => t.id)).toEqual(["file:a.ts", "terminal"]);
    expect(closed.activeId).toBe("terminal");
  });

  it("关掉最后一个标签后没有激活标签（面板给空态，而不是崩）", () => {
    const closed = closePanelTab(
      [tab({ kind: "changes" })],
      "changes",
      "changes",
    );
    expect(closed.tabs).toEqual([]);
    expect(closed.activeId).toBeNull();
  });

  it("关闭一个不存在的标签是 no-op", () => {
    const tabs = [tab({ kind: "changes" })];
    expect(closePanelTab(tabs, "changes", "terminal")).toEqual({
      tabs,
      activeId: "changes",
    });
  });

  it("标签 id 与标题：文件类取末段，视图类取视图名", () => {
    expect(panelViewId({ kind: "diff", path: "apps/web/src/lib/a.ts" })).toBe(
      "diff:apps/web/src/lib/a.ts",
    );
    expect(baseName("apps/web/src/lib/a.ts")).toBe("a.ts");
    expect(baseName("")).toBe("");
    expect(panelViewLabel({ kind: "files" })).toBe("文件目录");
    expect(panelViewLabel({ kind: "file", path: "a/b/README.md" })).toBe(
      "README.md",
    );
  });

  it("相对时刻按参考图口径：刚刚 / N分钟 / N小时 / N天", () => {
    const now = 1_000_000_000_000;
    expect(relativeOpenedLabel(now - 5_000, now)).toBe("刚刚");
    expect(relativeOpenedLabel(now - 5 * 60_000, now)).toBe("5分钟");
    expect(relativeOpenedLabel(now - 3 * 3_600_000, now)).toBe("3小时");
    expect(relativeOpenedLabel(now - 50 * 3_600_000, now)).toBe("2天");
  });

  it("溢出下拉的搜索按标题过滤且大小写不敏感", () => {
    const tabs = [
      tab({ kind: "terminal" }),
      tab({ kind: "file", path: "src/App.tsx" }),
    ];
    expect(filterPanelTabs(tabs, "app")).toHaveLength(1);
    expect(filterPanelTabs(tabs, "  终端 ")).toHaveLength(1);
    expect(filterPanelTabs(tabs, "")).toHaveLength(2);
    expect(filterPanelTabs(tabs, "不存在")).toHaveLength(0);
  });
});
