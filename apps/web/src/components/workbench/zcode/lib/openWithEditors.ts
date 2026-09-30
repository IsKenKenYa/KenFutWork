/**
 * zcode 照搬：`@/lib/openWithEditors.ts`（references/zcode/packages/ui/src/lib/openWithEditors.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import type { EditorInfo } from "@zui/lib/zcode-shared";

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
