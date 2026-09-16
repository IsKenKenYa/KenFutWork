/**
 * 右栏浏览器面板的**面板内历史栈**。
 *
 * **为什么不直接用 `iframe.contentWindow.history`**：内嵌页面基本都是跨源的，就读不到它的
 * history（同源才行）。所以后退/前进走我们自己的栈——**记的是用户在本面板里打开过的地址**，
 * 与目标站点的真实历史（页面内跳转、`history.pushState`）不是一回事。界面上按这个口径写清楚，
 * 不假装是浏览器历史。
 */

export interface BrowserHistoryState {
  entries: string[];
  /** 当前停在 entries 的哪一项（-1 = 还没打开过任何页面）。 */
  index: number;
}

/** 栈上限：面板是用来「顺手看一眼」的，留最近 50 个足够，也不至于把内存撑起来。 */
export const MAX_HISTORY_ENTRIES = 50;

export function createHistory(): BrowserHistoryState {
  return { entries: [], index: -1 };
}

/**
 * 打开一个地址：从当前位置**截断前进分支**再入栈（与浏览器一致——回退后再打开新页面，
 * 「前进」里那条就没了）。重复打开当前地址不入栈（避免后退键原地打转）。
 */
export function openUrl(
  state: BrowserHistoryState,
  url: string,
): BrowserHistoryState {
  if (!url) return state;
  if (currentUrl(state) === url) return state;
  const entries = [...state.entries.slice(0, state.index + 1), url].slice(
    -MAX_HISTORY_ENTRIES,
  );
  return { entries, index: entries.length - 1 };
}

export function canGoBack(state: BrowserHistoryState): boolean {
  return state.index > 0;
}

export function canGoForward(state: BrowserHistoryState): boolean {
  return state.index >= 0 && state.index < state.entries.length - 1;
}

export function goBack(state: BrowserHistoryState): BrowserHistoryState {
  return canGoBack(state) ? { ...state, index: state.index - 1 } : state;
}

export function goForward(state: BrowserHistoryState): BrowserHistoryState {
  return canGoForward(state) ? { ...state, index: state.index + 1 } : state;
}

/** 当前地址（还没打开过任何页面时是空串）。 */
export function currentUrl(state: BrowserHistoryState): string {
  return state.index >= 0 ? (state.entries[state.index] ?? "") : "";
}
