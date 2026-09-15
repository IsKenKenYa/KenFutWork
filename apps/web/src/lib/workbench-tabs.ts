/**
 * 工作台画布标签（Design 模式）的纯逻辑。
 *
 * 语义与编辑器里的文件标签一致：**打开过的画布各占一个标签**，可以同时开多个、
 * 点一下切换、× 关掉，刷新后仍在（localStorage）。工作台只负责把选中项目同步进来，
 * 具体增删与「关掉当前标签后选谁」这类判定都在这里，便于单测。
 */
export type WorkbenchTab = {
  projectId: string;
  /** 该项目的画布 id（标签内容由画布页承载）。 */
  canvasId: string;
  /** 标签文字＝项目名。 */
  name: string;
};

const STORAGE_KEY = "workbench:open-tabs";
/** 标签上限：再多也放不下，且 localStorage 不该无限增长。 */
const MAX_TABS = 20;

export function loadTabs(): WorkbenchTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is WorkbenchTab =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as WorkbenchTab).projectId === "string" &&
          typeof (t as WorkbenchTab).canvasId === "string" &&
          typeof (t as WorkbenchTab).name === "string",
      )
      .slice(0, MAX_TABS);
  } catch {
    return [];
  }
}

export function saveTabs(tabs: WorkbenchTab[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs.slice(0, MAX_TABS)));
  } catch {
    // 存储失败不影响使用（标签只是视图状态）
  }
}

/**
 * 打开/聚焦一个画布：已存在则**原地更新**字段（项目改名、画布变了都要跟上），
 * 不存在则追加到末尾。没有任何变化时返回原数组引用，避免无谓的重渲染与写盘。
 */
export function upsertTab(
  tabs: WorkbenchTab[],
  tab: WorkbenchTab,
): WorkbenchTab[] {
  const idx = tabs.findIndex((t) => t.projectId === tab.projectId);
  if (idx < 0) return [...tabs, tab].slice(-MAX_TABS);
  const current = tabs[idx]!;
  if (
    current.canvasId === tab.canvasId &&
    current.name === tab.name
  ) {
    return tabs;
  }
  const next = [...tabs];
  next[idx] = tab;
  return next;
}

/**
 * 关掉一个标签。关的不是当前标签时，当前标签不变；关的是当前标签时，
 * **右邻优先、其次左邻**（编辑器的通行做法），全关光了就没有当前标签。
 */
export function closeTab(
  tabs: WorkbenchTab[],
  projectId: string,
  activeId: string | null,
): { tabs: WorkbenchTab[]; nextActiveId: string | null } {
  const idx = tabs.findIndex((t) => t.projectId === projectId);
  if (idx < 0) return { tabs, nextActiveId: activeId };
  const rest = tabs.filter((_, i) => i !== idx);
  if (activeId !== projectId) return { tabs: rest, nextActiveId: activeId };
  const neighbour = rest[idx] ?? rest[idx - 1] ?? null;
  return { tabs: rest, nextActiveId: neighbour?.projectId ?? null };
}

/** 丢掉已经不在项目列表里的标签（项目被删/换账号）。 */
export function pruneTabs(
  tabs: WorkbenchTab[],
  knownProjectIds: Iterable<string>,
): WorkbenchTab[] {
  const known = new Set(knownProjectIds);
  const kept = tabs.filter((t) => known.has(t.projectId));
  return kept.length === tabs.length ? tabs : kept;
}
