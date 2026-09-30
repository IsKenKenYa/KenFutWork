/**
 * zcode 照搬：`@/mentions/activePromptInputToken.ts`（references/zcode/packages/ui/src/mentions/activePromptInputToken.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import {
  type ActivePromptInputTrigger,
  extractActivePromptInputTrigger,
} from "@zui/lib/promptInputTriggers";

interface PromptInputTextSelectionSnapshot {
  cursorOffset: number;
  nodeKey: string;
  text: string;
  textBeforeCursor: string;
}

export interface ActivePromptInputTokenSnapshot
  extends ActivePromptInputTrigger {
  nodeKey: string;
  tokenEnd: number;
  tokenStart: number;
  tokenText: string;
}

function isCaretInsideToken(
  snapshot: ActivePromptInputTokenSnapshot,
  cursorOffset: number,
): boolean {
  return (
    cursorOffset >= snapshot.tokenStart + 1 && cursorOffset <= snapshot.tokenEnd
  );
}

function createActivePromptInputTokenSnapshot(
  selection: PromptInputTextSelectionSnapshot,
): ActivePromptInputTokenSnapshot | null {
  const activeTrigger = extractActivePromptInputTrigger(
    selection.textBeforeCursor,
  );
  if (!activeTrigger) {
    return null;
  }

  const tokenStart = selection.cursorOffset - activeTrigger.query.length - 1;
  const tokenEnd = selection.cursorOffset;
  return {
    ...activeTrigger,
    nodeKey: selection.nodeKey,
    tokenEnd,
    tokenStart,
    tokenText: selection.text.slice(tokenStart, tokenEnd),
  };
}

export function reconcileActivePromptInputTokenSnapshot(
  previous: ActivePromptInputTokenSnapshot | null,
  selection: PromptInputTextSelectionSnapshot,
  selectionOnly: boolean,
): ActivePromptInputTokenSnapshot | null {
  if (!selectionOnly || !previous) {
    return createActivePromptInputTokenSnapshot(selection);
  }

  if (previous.nodeKey !== selection.nodeKey) {
    return null;
  }

  const currentTokenText = selection.text.slice(
    previous.tokenStart,
    previous.tokenEnd,
  );
  if (currentTokenText !== previous.tokenText) {
    return createActivePromptInputTokenSnapshot(selection);
  }

  if (!isCaretInsideToken(previous, selection.cursorOffset)) {
    return null;
  }

  // ArrowLeft/ArrowRight 只改变 selection，token 文本并未改变。
  // 若仍按光标前缀重算 query，会反复过滤候选、重置 selectedIndex 并重建虚拟列表。
  return previous;
}

export function getActivePromptInputTokenReplacementRange(
  snapshot: ActivePromptInputTokenSnapshot | null,
  selection: PromptInputTextSelectionSnapshot,
): { end: number; start: number } | null {
  if (
    !snapshot ||
    snapshot.nodeKey !== selection.nodeKey ||
    !isCaretInsideToken(snapshot, selection.cursorOffset) ||
    selection.text.slice(snapshot.tokenStart, snapshot.tokenEnd) !==
      snapshot.tokenText
  ) {
    return null;
  }

  return { end: snapshot.tokenEnd, start: snapshot.tokenStart };
}
