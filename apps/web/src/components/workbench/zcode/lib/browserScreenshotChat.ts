/**
 * 「浏览器截图进对话」：与画布截图同一条路（window 事件 → 聚焦 composer 消费）。
 *
 * 载荷直接带 PNG `File`（面板从 /api/browser/cdp/screenshot 拿 base64 组好），
 * 「同工作区才注入」沿用白板/画布口径（identity 优先，退 path）。
 */
export interface BrowserScreenshotChatPayload {
  /** 截图来源页标题（附件名跟着走）。 */
  title: string | null;
  file: File;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
}

export const BROWSER_SCREENSHOT_ADD_TO_CHAT_EVENT =
  "zcode:add-browser-screenshot-to-chat";

export function buildBrowserScreenshotWorkspaceKey(payload: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return payload.workspaceIdentity?.trim() || payload.workspacePath;
}

function isPayload(value: unknown): value is BrowserScreenshotChatPayload {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<BrowserScreenshotChatPayload>;
  return (
    (detail.title === null || typeof detail.title === "string") &&
    typeof detail.workspacePath === "string" &&
    (detail.workspaceIdentity === undefined ||
      typeof detail.workspaceIdentity === "string") &&
    typeof File !== "undefined" &&
    detail.file instanceof File
  );
}

export function isBrowserScreenshotAddToChatEvent(
  event: Event,
): event is CustomEvent<BrowserScreenshotChatPayload> {
  return (
    event.type === BROWSER_SCREENSHOT_ADD_TO_CHAT_EVENT &&
    typeof CustomEvent !== "undefined" &&
    event instanceof CustomEvent &&
    isPayload(event.detail)
  );
}

export function dispatchBrowserScreenshotAddToChat(
  payload: BrowserScreenshotChatPayload,
): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(BROWSER_SCREENSHOT_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}
