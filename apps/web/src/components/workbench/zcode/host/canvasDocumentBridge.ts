import {
  type CanvasDocumentUpdatedMessage,
  canvasDocumentUpdatedMessageSchema,
} from "@kenfutwork/shared";
import {
  type ConversationWorkContext,
  conversationWorkContextSchema,
} from "@zcode/shared/zcode-protocol-v4";

/** 文档宿主只接受自己 iframe 的回执；metadata 操作使用编辑器真实保存后的 revision。 */
export function installCanvasDocumentBridge(options: {
  projectId: string;
  canvasId: string;
  target: () => Window | null;
  onContext: (context: ConversationWorkContext) => void;
  onFocus: () => void;
  onNewProject: () => void;
  onProjectDeleted: () => void;
  onDocumentUpdated: (message: CanvasDocumentUpdatedMessage) => void;
}) {
  let unavailable = false;
  const pending = new Map<
    string,
    {
      resolve: (revision: string) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const rejectPreparations = (message: string) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  };
  const post = (type: string, detail: Record<string, unknown> = {}) => {
    if (unavailable) return;
    options.target()?.postMessage(
      {
        type,
        projectId: options.projectId,
        canvasId: options.canvasId,
        ...detail,
      },
      window.location.origin,
    );
  };
  const receive = (event: MessageEvent) => {
    if (unavailable) return;
    const target = options.target();
    if (
      !target ||
      event.source !== target ||
      event.origin !== window.location.origin
    )
      return;
    const data = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      data.projectId !== options.projectId
    )
      return;
    if (data.type === "workbench:project-deleted") {
      options.onProjectDeleted();
      return;
    }
    if (data.canvasId !== options.canvasId) return;
    if (data.type === "kenfutwork:canvas-document-updated") {
      const parsed = canvasDocumentUpdatedMessageSchema.safeParse({
        ...data,
        type: "canvas.document.updated",
      });
      if (parsed.success) {
        if (parsed.data.deleted) {
          unavailable = true;
          rejectPreparations("画布已删除，请选择其他画布");
        }
        options.onDocumentUpdated(parsed.data);
      }
    } else if (data.type === "kenfutwork:canvas-prepared") {
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      clearTimeout(request.timer);
      if (
        typeof data.revision === "string" &&
        /^[a-f0-9]{64}$/u.test(data.revision)
      )
        request.resolve(data.revision);
      else request.reject(new Error("画布保存失败，请重试"));
    } else if (data.type === "kenfutwork:canvas-context") {
      const parsed = conversationWorkContextSchema.safeParse({
        preset: "design",
        canvasId: options.canvasId,
        selectedCanvasElements: data.selectedCanvasElements,
        ...(typeof data.brandKitId === "string"
          ? { brandKitId: data.brandKitId }
          : {}),
      });
      if (parsed.success) options.onContext(parsed.data);
    } else if (data.type === "kenfutwork:canvas-focus-session")
      options.onFocus();
    else if (data.type === "kenfutwork:canvas-new-project")
      options.onNewProject();
  };
  window.addEventListener("message", receive);
  return {
    bindTask(taskId: string | null, active: boolean) {
      if (unavailable) return;
      post("kenfutwork:canvas-session-context", {
        taskId: active ? taskId : null,
      });
      options
        .target()
        ?.postMessage(
          { type: "kenfutwork:workspace-activity", active },
          window.location.origin,
        );
    },
    prepare(): Promise<string> {
      if (unavailable)
        return Promise.reject(new Error("画布已关闭，请重新打开"));
      if (!options.target())
        return Promise.reject(new Error("画布尚未就绪，请稍后重试"));
      const requestId = crypto.randomUUID();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("画布保存未完成，请重试"));
        }, 10_000);
        pending.set(requestId, { resolve, reject, timer });
        post("kenfutwork:canvas-prepare", { requestId });
      });
    },
    dispose() {
      unavailable = true;
      window.removeEventListener("message", receive);
      rejectPreparations("画布已关闭，请重新打开");
    },
  };
}
