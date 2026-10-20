/**
 * 「画布截图进对话」：与白板导出同一条路（window 事件 → 聚焦 composer 消费）。
 *
 * 载荷直接带 PNG `File`（面板已经拿着截图），不像白板那样按 boardId 回查——
 * 面板在共享侧栏里，不随会话重挂，也没有可回查的本地画布实体。
 * 「同工作区才注入」沿用白板口径（identity 优先，退 path）。
 */
export interface OpenDesignCanvasChatPayload {
  projectId: string;
  /** 画布名（附件名跟着走）。 */
  title: string | null;
  file: File;
  workspacePath: string;
  workspaceIdentity?: string;
}

export const OPEN_DESIGN_CANVAS_ADD_TO_CHAT_EVENT =
  "zcode:add-open-design-canvas-to-chat";

export function buildOpenDesignCanvasWorkspaceKey(payload: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return payload.workspaceIdentity?.trim() || payload.workspacePath;
}

function isPayload(value: unknown): value is OpenDesignCanvasChatPayload {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<OpenDesignCanvasChatPayload>;
  return (
    typeof detail.projectId === "string" &&
    (detail.title === null || typeof detail.title === "string") &&
    typeof detail.workspacePath === "string" &&
    (detail.workspaceIdentity === undefined ||
      typeof detail.workspaceIdentity === "string") &&
    typeof File !== "undefined" &&
    detail.file instanceof File
  );
}

export function isOpenDesignCanvasAddToChatEvent(
  event: Event,
): event is CustomEvent<OpenDesignCanvasChatPayload> {
  return (
    event.type === OPEN_DESIGN_CANVAS_ADD_TO_CHAT_EVENT &&
    typeof CustomEvent !== "undefined" &&
    event instanceof CustomEvent &&
    isPayload(event.detail)
  );
}

export function dispatchOpenDesignCanvasAddToChat(
  payload: OpenDesignCanvasChatPayload,
): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent(OPEN_DESIGN_CANVAS_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}