/**
 * zcode 照搬：`@/mentions/PromptClipboardPlugin.tsx`（references/zcode/packages/ui/src/mentions/PromptClipboardPlugin.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬；import 路径映射（手册 §2.1）+ 本地 import 去 .js 后缀
 *（本仓 Turbopack 不做 .js→.ts/.tsx 试探，手册 §2.4-2 在本仓构建链的等价适配）。
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getAtomicPromptSelection,
  $getPromptSelectionMarkdown,
} from "@zui/mentions/promptSerialization";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  COPY_COMMAND,
  CUT_COMMAND,
  type LexicalEditor,
} from "lexical";
import { useEffect } from "react";

function registerPromptClipboard(editor: LexicalEditor): () => void {
  const handle = (
    event: ClipboardEvent | KeyboardEvent | null,
    cut: boolean,
  ): boolean => {
    const selection = $getSelection();
    if (
      !$isRangeSelection(selection) ||
      selection.isCollapsed() ||
      !event ||
      !("clipboardData" in event) ||
      !event.clipboardData
    )
      return false;
    const atomic = $getAtomicPromptSelection(selection);
    try {
      event.clipboardData.setData(
        "text/plain",
        $getPromptSelectionMarkdown(atomic),
      );
    } catch {
      // 根因：返回 false 会继续进入 PlainTextPlugin 的默认 CUT，写入失败仍可能删除选区。
      // 消费失败事件，保留草稿，让用户可以再次复制/剪切。
      event.preventDefault();
      return true;
    }
    event.preventDefault();
    if (cut && editor.isEditable()) {
      $setSelection(atomic);
      atomic.removeText();
    }
    return true;
  };
  const unregisterCopy = editor.registerCommand(
    COPY_COMMAND,
    (event) => handle(event, false),
    COMMAND_PRIORITY_HIGH,
  );
  const unregisterCut = editor.registerCommand(
    CUT_COMMAND,
    (event) => handle(event, true),
    COMMAND_PRIORITY_HIGH,
  );
  return () => {
    unregisterCopy();
    unregisterCut();
  };
}

export function PromptClipboardPlugin() {
  const [editor] = useLexicalComposerContext();
  useEffect(() => registerPromptClipboard(editor), [editor]);
  return null;
}
