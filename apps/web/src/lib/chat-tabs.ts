/**
 * 右侧面板的标签页纯逻辑。
 *
 * 标签有两种：
 * - `chat`：每个打开的历史对话一个标签（`id` = 会话 id）；
 * - `layers` / `files`：图层与生成文件两个**面板视图**，点底部/顶部的入口按钮就开一个标签
 *   （`id` 就是视图名本身）。
 *
 * 语义与编辑器一致：可以同时开多个、点一下切换、× 关掉，刷新后仍在（按画布分别存
 * localStorage）。增删与「关掉当前标签后选谁」都在这里，便于单测。
 */
export type TabKind = "chat" | "layers" | "files";

export type ChatTab = {
  kind: TabKind;
  /** chat 用会话 id；视图标签用视图名（layers / files）。 */
  id: string;
  /** 标签文字。 */
  title: string;
};

/** 标签上限：再多也放不下，且 localStorage 不该无限增长。 */
const MAX_TABS = 12;

/** 视图标签的固定标题。 */
export const VIEW_TAB_TITLES: Record<Exclude<TabKind, "chat">, string> = {
  layers: "图层",
  files: "生成文件",
};

export function tabsStorageKey(canvasId: string): string {
  return `chat-open-tabs:${canvasId}`;
}

export function loadTabs(canvasId: string): ChatTab[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(tabsStorageKey(canvasId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (t): t is ChatTab =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as ChatTab).id === "string" &&
          typeof (t as ChatTab).title === "string" &&
          ["chat", "layers", "files"].includes((t as ChatTab).kind),
      )
      .slice(0, MAX_TABS);
  } catch {
    return [];
  }
}

export function saveTabs(canvasId: string, tabs: ChatTab[]): void {
  try {
    window.localStorage.setItem(
      tabsStorageKey(canvasId),
      JSON.stringify(tabs.slice(0, MAX_TABS)),
    );
  } catch {
    // 存储失败不影响使用（标签只是视图状态）
  }
}

/**
 * 打开/聚焦一个标签：已开过则**原地更新标题**（会话自动改名要跟上），没开过则追加。
 * 无变化时返回原数组引用，避免无谓的重渲染与写盘。
 */
export function upsertTab(tabs: ChatTab[], tab: ChatTab): ChatTab[] {
  const idx = tabs.findIndex((t) => t.id === tab.id && t.kind === tab.kind);
  if (idx < 0) return [...tabs, tab].slice(-MAX_TABS);
  if (tabs[idx]?.title === tab.title) return tabs;
  const next = [...tabs];
  next[idx] = tab;
  return next;
}

/**
 * 关掉一个标签。关的不是当前标签时当前标签不变；关的是当前标签时
 * **右邻优先、其次左邻**；全关光就没有当前标签。
 */
export function closeTab(
  tabs: ChatTab[],
  id: string,
  kind: TabKind,
  activeId: string | null,
): { tabs: ChatTab[]; nextActiveId: string | null } {
  const idx = tabs.findIndex((t) => t.id === id && t.kind === kind);
  if (idx < 0) return { tabs, nextActiveId: activeId };
  const rest = tabs.filter((_, i) => i !== idx);
  const wasActive = activeId === id;
  if (!wasActive) return { tabs: rest, nextActiveId: activeId };
  // 接替者优先取同一个视图种类，其次右邻、再左邻
  const neighbour = rest[idx] ?? rest[idx - 1] ?? null;
  return { tabs: rest, nextActiveId: neighbour?.id ?? null };
}

/**
 * 清掉已不存在的会话标签（在别处删了、或换账号）。**视图标签不受影响**。
 */
export function pruneTabs(
  tabs: ChatTab[],
  knownSessionIds: Iterable<string>,
): ChatTab[] {
  const known = new Set(knownSessionIds);
  const kept = tabs.filter((t) => t.kind !== "chat" || known.has(t.id));
  return kept.length === tabs.length ? tabs : kept;
}
