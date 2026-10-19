import type { CanvasDocumentUpdatedMessage } from "@kenfutwork/shared";
import type { CanvasSelectedElement } from "@/components/canvas-editor";

export interface CanvasEditorTarget {
  canvasId: string;
  projectId: string;
}

export function canvasWorkbenchUrl(target?: CanvasEditorTarget): string {
  const query = new URLSearchParams({ mode: "design" });
  if (target) {
    query.set("projectId", target.projectId);
    query.set("canvasId", target.canvasId);
  }
  return `/workbench?${query.toString()}`;
}

/** 编辑器只接收其直接宿主的操作；会话身份不能来自 URL 或画布 ID。 */
export function installCanvasEditorBridge(options: {
  target: CanvasEditorTarget;
  parent: Window;
  origin: string;
  events: Pick<Window, "addEventListener" | "removeEventListener">;
  onRefresh: () => void;
  onSessionChange: (taskId: string | null) => void;
  onPrepare?: () => Promise<string | null>;
}) {
  const { target, parent, origin, events, onRefresh, onSessionChange } =
    options;
  let disposed = false;
  const preparations = new Map<string, Promise<string | null>>();
  const post = (type: string, detail: Record<string, unknown> = {}) => {
    if (!disposed) parent.postMessage({ type, ...target, ...detail }, origin);
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== origin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.canvasId !== target.canvasId)
      return;
    if (data.type === "kenfutwork:canvas-refresh") {
      onRefresh();
    } else if (
      data.type === "kenfutwork:canvas-prepare" &&
      data.projectId === target.projectId &&
      typeof data.requestId === "string" &&
      data.requestId.trim()
    ) {
      const requestId = data.requestId;
      let operation = preparations.get(requestId);
      if (!operation) {
        operation = Promise.resolve().then(() => options.onPrepare?.() ?? null);
        preparations.set(requestId, operation);
      }
      void operation
        .then((revision) =>
          post("kenfutwork:canvas-prepared", { requestId, revision }),
        )
        .catch(() =>
          post("kenfutwork:canvas-prepared", { requestId, revision: null }),
        );
    } else if (
      data.type === "kenfutwork:canvas-session-context" &&
      data.projectId === target.projectId &&
      (data.taskId === null ||
        (typeof data.taskId === "string" && data.taskId.trim()))
    ) {
      onSessionChange(data.taskId);
    }
  };
  events.addEventListener("message", receive);
  return {
    publishContext(
      selectedCanvasElements: CanvasSelectedElement[],
      brandKitId: string | null,
    ) {
      post("kenfutwork:canvas-context", { selectedCanvasElements, brandKitId });
    },
    publishDocumentUpdated(message: CanvasDocumentUpdatedMessage) {
      if (
        message.canvasId !== target.canvasId ||
        message.projectId !== target.projectId
      )
        return;
      post("kenfutwork:canvas-document-updated", {
        deleted: message.deleted,
        ...(message.revision ? { revision: message.revision } : {}),
      });
    },
    focusSession() {
      post("kenfutwork:canvas-focus-session");
    },
    requestProject() {
      post("kenfutwork:canvas-new-project");
    },
    /** 建/删画布由宿主执行：列表、保存版本与标签归属都在宿主一侧。 */
    requestCreateCanvas() {
      post("kenfutwork:canvas-create");
    },
    requestDeleteCanvas() {
      post("kenfutwork:canvas-delete");
    },
    dispose() {
      disposed = true;
      preparations.clear();
      events.removeEventListener("message", receive);
    },
  };
}

/** 同一画布的刷新串行应用；在飞刷新期间的通知在应用后再对账一次。 */
export function createCanvasRefreshCoordinator(refresh: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let pending = false;
  let disposed = false;
  return {
    refresh(): Promise<void> {
      if (disposed) return Promise.resolve();
      pending = true;
      if (running) return running;
      running = (async () => {
        while (pending && !disposed) {
          pending = false;
          await refresh();
        }
      })().finally(() => {
        running = null;
      });
      return running;
    },
    dispose() {
      disposed = true;
      pending = false;
    },
  };
}
