/**
 * 右侧面板的「对话标签页」纯逻辑（Editor 式：每个打开的历史对话占一个标签）。
 *
 * 语义：点历史对话不是把当前这轮顶掉，而是**新开一个标签**；标签可以同时开多个、
 * 点一下切换、× 关掉，切换画布/刷新页面后仍在（按画布分别存 localStorage）。
 * 组件只做展示与事件转发，增删与「关掉当前标签后选谁」这类判定都在这里，便于单测。
 */
export type ChatTab = {
  sessionId: string;
  /** 标签文字＝会话标题（会话自动改标题时会同步过来）。 */
  title: string;
};

/** 标签上限：再多也放不下，且 localStorage 不该无限增长。 */
const MAX_TABS = 12;

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
          typeof (t as ChatTab).sessionId === "string" &&
          typeof (t as ChatTab).title === "string",
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
 * 打开/聚焦一个对话：已开过则**原地更新标题**（会话自动改名要跟上），没开过则追加。
 * 无变化时返回原数组引用，避免无谓的重渲染与写盘。
 */
export function upsertTab(tabs: ChatTab[], tab: ChatTab): ChatTab[] {
  const idx = tabs.findIndex((t) => t.sessionId === tab.sessionId);
  if (idx < 0) return [...tabs, tab].slice(-MAX_TABS);
  if (tabs[idx]!.title === tab.title) return tabs;
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
  sessionId: string,
  activeId: string | null,
): { tabs: ChatTab[]; nextActiveId: string | null } {
  const idx = tabs.findIndex((t) => t.sessionId === sessionId);
  if (idx < 0) return { tabs, nextActiveId: activeId };
  const rest = tabs.filter((_, i) => i !== idx);
  if (activeId !== sessionId) return { tabs: rest, nextActiveId: activeId };
  const neighbour = rest[idx] ?? rest[idx - 1] ?? null;
  return { tabs: rest, nextActiveId: neighbour?.sessionId ?? null };
}

/**
 * 丢掉已不存在的会话（在别处删了、或换账号）。
 */
export function pruneTabs(
  tabs: ChatTab[],
  knownSessionIds: Iterable<string>,
): ChatTab[] {
  const known = new Set(knownSessionIds);
  const kept = tabs.filter((t) => known.has(t.sessionId));
  return kept.length === tabs.length ? tabs : kept;
}
