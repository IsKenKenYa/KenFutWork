/**
 * zcode 照搬：`@/lib/editorPreference.ts`（references/zcode/packages/ui/src/lib/editorPreference.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LAST_SELECTED_EDITOR_STORAGE_KEY = "zcode-last-editor-id";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readLastSelectedEditorId(
  storage: StorageLike | null = getBrowserStorage(),
): string | null {
  const rawValue = storage?.getItem(LAST_SELECTED_EDITOR_STORAGE_KEY);
  if (typeof rawValue !== "string" || rawValue.length === 0) {
    return null;
  }

  return rawValue;
}

export function persistLastSelectedEditorId(
  editorId: string,
  storage: StorageLike | null = getBrowserStorage(),
) {
  storage?.setItem(LAST_SELECTED_EDITOR_STORAGE_KEY, editorId);
}
