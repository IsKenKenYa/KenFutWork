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

/**
 * 面板历史的本地持久化：右栏浏览器「清除浏览器数据 / 导入…」操作的就是这一份
 * （它只包含**本面板打开过的地址**，不含目标站点的 cookie / 缓存——那些在 iframe 里，
 * 跨源拿不到，界面上如实写清）。
 */
export const BROWSER_HISTORY_STORAGE_KEY = "workbench:browser-history";

export function loadHistory(): BrowserHistoryState {
  if (typeof window === "undefined") return createHistory();
  try {
    const raw = window.localStorage.getItem(BROWSER_HISTORY_STORAGE_KEY);
    if (!raw) return createHistory();
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return createHistory();
  }
}

export function saveHistory(state: BrowserHistoryState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      BROWSER_HISTORY_STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch {
    // 存不进去不影响使用（面板还是能开页面）
  }
}

export function clearHistory(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BROWSER_HISTORY_STORAGE_KEY);
}

/**
 * 解析导入的历史（JSON 文本）。接受两种形状：本模块导出的 `{entries, index}`，
 * 以及纯地址数组 `["https://…", …]`。非法输入返回 null（调用方给可读提示）。
 */
export function parseImportedHistory(text: string): BrowserHistoryState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // 纯地址数组没有「当前停在哪」这条信息：默认停在**最后一条**（最近打开的那个）
  const candidate = Array.isArray(parsed)
    ? { entries: parsed, index: undefined }
    : parsed;
  const state = normalizeHistory(candidate);
  return state.entries.length > 0 ? state : null;
}

/** 归一化：只留字符串、去空、截到上限，index 夹到合法范围。 */
function normalizeHistory(value: unknown): BrowserHistoryState {
  if (typeof value !== "object" || value === null) return createHistory();
  const rawEntries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(rawEntries)) return createHistory();
  const entries = rawEntries
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(-MAX_HISTORY_ENTRIES);
  if (entries.length === 0) return createHistory();
  const rawIndex = (value as { index?: unknown }).index;
  const index =
    typeof rawIndex === "number" && Number.isInteger(rawIndex)
      ? Math.min(Math.max(rawIndex, 0), entries.length - 1)
      : entries.length - 1;
  return { entries, index };
}
