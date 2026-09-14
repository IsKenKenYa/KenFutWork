/**
 * 输入框（对话框）右键菜单的纯逻辑：文本区间编辑 + 轻量撤销/重做历史。
 *
 * 背景：应用内浏览器不弹原生编辑菜单，用户在输入框里右键拿不到
 * 撤销/重做/剪切/复制/粘贴/删除/全选。这里把「怎么改文本」抽成纯函数，
 * 组件层（components/chat/composer-context-menu.tsx）只负责取值与回填。
 *
 * 撤销/重做为**自管历史**而非 `document.execCommand("undo")`：输入框是受控
 * 组件（值来自 React state），原生 undo 只改 DOM 不改 state，会造成界面与
 * 状态不一致。历史按「打字批次」合并（间隔小于阈值不新开条目），否则逐字符撤销没有意义。
 */

export const HISTORY_LIMIT = 100;
/** 间隔小于该毫秒数的连续输入合并为一条历史（避免逐字符撤销）。 */
export const HISTORY_COALESCE_MS = 800;

export interface TextRange {
  start: number;
  end: number;
}

/** 把区间夹到文本范围内并保证 start <= end（输入框 selection 可能是反向的）。 */
export function normalizeRange(value: string, range: TextRange): TextRange {
  const max = value.length;
  const a = Math.max(0, Math.min(range.start, max));
  const b = Math.max(0, Math.min(range.end, max));
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** 用替换文本覆盖区间，返回新值与插入点后的光标位置。 */
export function replaceRange(
  value: string,
  range: TextRange,
  replacement: string,
): { value: string; caret: number } {
  const { start, end } = normalizeRange(value, range);
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    caret: start + replacement.length,
  };
}

/** 删除区间（剪切/删除共用）。 */
export function deleteRange(
  value: string,
  range: TextRange,
): { value: string; caret: number } {
  return replaceRange(value, range, "");
}

/** 取区间文本（复制/剪切用）；无区间返回空串。 */
export function rangeText(value: string, range: TextRange): string {
  const { start, end } = normalizeRange(value, range);
  return value.slice(start, end);
}

/** 全选区间。 */
export function selectAllRange(value: string): TextRange {
  return { start: 0, end: value.length };
}

export interface TextHistory {
  past: string[];
  future: string[];
  /** 上一条历史的写入时间（合并打字批次用）。 */
  lastAt: number;
}

export const EMPTY_TEXT_HISTORY: TextHistory = {
  past: [],
  future: [],
  lastAt: 0,
};

/**
 * 记录一次变更前的值。间隔短于 `HISTORY_COALESCE_MS` 时**替换**上一条
 * （同一打字批次只留一个还原点），否则追加；任何新输入都清空重做栈。
 */
export function recordHistory(
  history: TextHistory,
  previous: string,
  now: number,
  options: { limit?: number; coalesceMs?: number } = {},
): TextHistory {
  const limit = options.limit ?? HISTORY_LIMIT;
  const coalesceMs = options.coalesceMs ?? HISTORY_COALESCE_MS;
  if (history.past.length > 0 && now - history.lastAt < coalesceMs) {
    return { past: history.past, future: [], lastAt: now };
  }
  const past = [...history.past, previous];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    future: [],
    lastAt: now,
  };
}

/** 撤销：返回要恢复的值与新历史；无可撤销时返回 null。 */
export function undoHistory(
  history: TextHistory,
  current: string,
): { value: string; history: TextHistory } | null {
  const previous = history.past.at(-1);
  if (previous === undefined) {
    return null;
  }
  return {
    value: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future],
      lastAt: 0,
    },
  };
}

/** 重做：返回要恢复的值与新历史；无可重做时返回 null。 */
export function redoHistory(
  history: TextHistory,
  current: string,
): { value: string; history: TextHistory } | null {
  const next = history.future[0];
  if (next === undefined) {
    return null;
  }
  return {
    value: next,
    history: {
      past: [...history.past, current],
      future: history.future.slice(1),
      lastAt: 0,
    },
  };
}

/** 输入框右键菜单项（文案与快捷键同源，便于测试与文档）。 */
export interface ComposerMenuItem {
  id: "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "select-all";
  label: string;
  shortcut: string;
}

export const COMPOSER_MENU_ITEMS: readonly ComposerMenuItem[] = [
  { id: "undo", label: "撤销", shortcut: "Ctrl+Z" },
  { id: "redo", label: "重做", shortcut: "Ctrl+Y" },
  { id: "cut", label: "剪切", shortcut: "Ctrl+X" },
  { id: "copy", label: "复制", shortcut: "Ctrl+C" },
  { id: "paste", label: "粘贴", shortcut: "Ctrl+V" },
  { id: "delete", label: "删除", shortcut: "" },
  { id: "select-all", label: "全选", shortcut: "Ctrl+A" },
] as const;
