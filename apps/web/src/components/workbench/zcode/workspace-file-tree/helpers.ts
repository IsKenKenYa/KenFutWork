/**
 * zcode 照搬（部分）：`@/workspace-file-tree/helpers` 中照搬组件实际消费的切片。
 * 来源：references/zcode/packages/ui/src/workspace-file-tree/helpers.ts
 * 许可证：Apache-2.0（zcode）。
 */

import type { EditorInfo } from "../lib/zcode-shared";

const PINNED_OPEN_WITH_EDITOR_IDS = [
  "finder",
  "qspace",
  "qspace-pro",
  "explorer",
] as const;

export function isFileManagerOpenTarget(editor: EditorInfo): boolean {
  return (PINNED_OPEN_WITH_EDITOR_IDS as readonly string[]).includes(editor.id);
}

export function sortInstalledEditorsForOpenWith(
  editors: EditorInfo[],
): EditorInfo[] {
  const editorById = new Map(editors.map((editor) => [editor.id, editor]));
  const pinnedEditors = PINNED_OPEN_WITH_EDITOR_IDS.map(
    (editorId) => editorById.get(editorId) ?? null,
  ).filter((editor): editor is EditorInfo => editor !== null);
  const pinnedEditorIds = new Set<string>(PINNED_OPEN_WITH_EDITOR_IDS);
  const regularEditors = editors.filter(
    (editor) => !pinnedEditorIds.has(editor.id),
  );

  return [...pinnedEditors, ...regularEditors];
}

export const sortInstalledEditorsForFileTree = sortInstalledEditorsForOpenWith;
