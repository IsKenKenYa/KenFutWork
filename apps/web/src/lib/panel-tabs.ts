/**
 * 右栏面板的「编辑器式多标签」模型（用户口径：像画布右侧面板那样，每个视图/文件各开一个标签，
 * 可关，关掉后右邻接替——不再是固定分类的标签条）。
 *
 * 为什么抽成纯函数：这一层的判定全是**顺序与身份**问题（谁接替谁、重复点同一个文件要不要
 * 新开一个标签），顺序错了界面上就是「标签凭空消失/重复堆积」，这类 bug 靠肉眼看截图很难发现，
 * 必须用单测钉死（见 test/panel-tabs.test.ts）。
 */

/** 面板里能开的视图种类。 */
export type PanelViewKind =
  | "changes"
  | "files"
  | "terminal"
  | "browser"
  | "subagents"
  | "diff"
  | "file";

export interface PanelView {
  kind: PanelViewKind;
  /** 文件 / 目录路径（diff、file 用；files 只用它的初始目录）。 */
  path?: string | undefined;
}

export interface PanelTab {
  /** 视图身份：同一种视图（同一文件）重复打开是同一个标签，而不是堆两个。 */
  id: string;
  view: PanelView;
  /** 标签上的标题（文件名 / 视图名）。 */
  label: string;
  /** 打开时刻（标签溢出下拉里显示「刚刚 / N 分钟 / N 小时」，对齐参考图）。 */
  openedAt: number;
}

/** 标签 id：固定视图用种类名，文件类视图带上路径（同一文件只开一个标签）。 */
export function panelViewId(view: PanelView): string {
  if (view.kind === "diff" || view.kind === "file") {
    return `${view.kind}:${view.path ?? ""}`;
  }
  return view.kind;
}

/** 路径的末段（标签标题用；空路径给整条）。 */
export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const VIEW_LABELS: Record<PanelViewKind, string> = {
  changes: "变更",
  files: "文件目录",
  terminal: "终端",
  browser: "浏览器",
  subagents: "子智能体",
  diff: "",
  file: "",
};

export function panelViewLabel(view: PanelView): string {
  return view.kind === "diff" || view.kind === "file"
    ? baseName(view.path ?? "（未命名）")
    : VIEW_LABELS[view.kind];
}

export function makePanelTab(view: PanelView, openedAt: number): PanelTab {
  return {
    id: panelViewId(view),
    view,
    label: panelViewLabel(view),
    openedAt,
  };
}

/**
 * 打开一个视图：已经在标签里就**激活**它（不新开、也不挪动位置——位置是用户肌肉记忆的一部分）；
 * 否则追加到最右并激活。返回新的标签数组与激活 id。
 */
export function openPanelTab(
  tabs: PanelTab[],
  activeId: string | null,
  view: PanelView,
  openedAt: number,
  newTab: PanelTab = makePanelTab(view, openedAt),
): { tabs: PanelTab[]; activeId: string } {
  const id = panelViewId(view);
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) {
    return { tabs, activeId: existing.id };
  }
  return { tabs: [...tabs, newTab], activeId: id };
}

/**
 * 关掉一个标签：**右邻接替**（没有右邻就左邻；都没有就没有激活标签）。
 * 关掉的不是当前激活标签时，激活态不动——别把用户正在看的视图切走。
 */
export function closePanelTab(
  tabs: PanelTab[],
  activeId: string | null,
  id: string,
): { tabs: PanelTab[]; activeId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== id);
  if (id !== activeId) {
    return { tabs: next, activeId };
  }
  const successor = next[index] ?? next[index - 1] ?? null;
  return { tabs: next, activeId: successor?.id ?? null };
}

/** 标签溢出下拉里的相对时刻（参考图：`1小时`）。 */
export function relativeOpenedLabel(openedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - openedAt) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

/** 溢出下拉里的搜索：按标题过滤（大小写不敏感）。 */
export function filterPanelTabs(tabs: PanelTab[], query: string): PanelTab[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return tabs;
  return tabs.filter((tab) => tab.label.toLowerCase().includes(needle));
}
