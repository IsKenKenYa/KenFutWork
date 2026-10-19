import type {
  DocumentSidePaneTab,
  OpenDocumentSidePaneRequest,
  WorkspaceSidePaneState,
} from "@zui/lib/workspaceSidePane.js";

export const CANVAS_DOCUMENT_UPDATED_EVENT = "kenfutwork:document-updated";
export const CANVAS_DOCUMENT_DELETED_EVENT = "kenfutwork:document-deleted";
export interface CanvasDocumentDeleted {
  projectId: string;
  canvasId: string;
}

/** 模式进入只恢复项目自己的文档；持续消息/工具事件不参与默认选择。 */
export function resolveDesignDocumentEntry(
  state: WorkspaceSidePaneState | null,
  scope: { projectId: string; workspaceKey: string },
  preferredTabId?: string,
): OpenDocumentSidePaneRequest {
  const documents =
    state?.tabs.filter(
      (tab): tab is DocumentSidePaneTab =>
        tab.type === "document" &&
        tab.projectId === scope.projectId &&
        tab.workspaceKey === scope.workspaceKey,
    ) ?? [];
  const selected =
    documents.find((tab) => tab.id === state?.activeTabId) ??
    documents.find((tab) => tab.id === preferredTabId) ??
    [...documents].reverse().find((tab) => tab.documentId) ??
    documents.at(-1);
  return {
    resourceType: "canvas",
    projectId: scope.projectId,
    ...(selected?.documentId ? { documentId: selected.documentId } : {}),
    title: selected?.title ?? "画布",
  };
}

/** Workspace memory 尚在切换时不把旧工作区的状态当作新项目空态。 */
export function hasPendingDocumentWorkspaceRestore(
  state: WorkspaceSidePaneState | null,
  workspaceKey: string,
): boolean {
  return Boolean(
    state?.tabs.length &&
      state.tabs.every(
        (tab) => tab.workspaceKey && tab.workspaceKey !== workspaceKey,
      ),
  );
}
