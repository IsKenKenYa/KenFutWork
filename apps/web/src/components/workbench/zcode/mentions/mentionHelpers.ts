/**
 * zcode 照搬：`@/mentions/mentionHelpers.ts`（references/zcode/packages/ui/src/mentions/mentionHelpers.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */
import { $getSelection, $isRangeSelection, $isTextNode } from "lexical";
export function getCurrentTextNodeSelection() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return null;
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const text = node.getTextContent();
  return {
    selection,
    node,
    cursorOffset: anchor.offset,
    nodeKey: node.getKey(),
    text,
    textAfterCursor: text.slice(anchor.offset),
    textBeforeCursor: text.slice(0, anchor.offset),
  };
}
