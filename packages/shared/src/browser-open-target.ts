export type BrowserOpenTarget = "panel" | "system";

export const BROWSER_OPEN_TARGET_KEY = "workbench:browser-open-target";

/** 沿用既有设置键；存储不可访问时由调用方显示错误。 */
export function readBrowserOpenTarget(storage: {
  getItem(key: string): string | null;
}): BrowserOpenTarget {
  return storage.getItem(BROWSER_OPEN_TARGET_KEY) === "system"
    ? "system"
    : "panel";
}

export function writeBrowserOpenTarget(
  storage: { setItem(key: string, value: string): void },
  target: BrowserOpenTarget,
): void {
  storage.setItem(BROWSER_OPEN_TARGET_KEY, target);
}

export function browserOpenTargetError(
  error: unknown,
  operation: "read" | "save",
): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? error.name
      : null;
  if (name === "QuotaExceededError")
    return "存储空间不足，请清理后重新选择浏览器。";
  if (name === "SecurityError")
    return "浏览器选择无法访问，请允许本地存储后重试。";
  return operation === "save"
    ? "浏览器选择未保存，请检查本地存储后重试。"
    : "浏览器选择读取失败，请检查本地存储后重试。";
}
