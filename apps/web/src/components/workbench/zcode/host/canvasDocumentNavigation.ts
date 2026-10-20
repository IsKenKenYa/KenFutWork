import {
  canvasGetResponseSchema,
  canvasListResponseSchema,
} from "@kenfutwork/shared";
import type {
  DocumentSidePaneTab,
  OpenDocumentSidePaneRequest,
  WorkspaceSidePaneState,
} from "@zui/lib/workspaceSidePane.js";
import { surfaceJson } from "./surfaceApi.js";

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

/**
 * 进入 Design 时把「该打开哪个画布」敲定成真实文档：主画布优先，项目里一个画布
 * 都没有就建一个再打开。
 *
 * 必须由宿主在开标签**之前**调用：`resolveDesignDocumentEntry` 在没有文档标签时
 * 只能给出 `{title:"画布"}` 且没有 documentId，先开一个空标签、再由画布视图自己去
 * 请求真实文档，会得到第二个标签——空白的「画布」和真正的「未命名画布」并排
 * （2026-10-20 用户截图）。
 */
export async function ensureDesignCanvasEntry(projectId: string): Promise<{
  documentId: string;
  title: string;
}> {
  const list = canvasListResponseSchema.safeParse(
    await surfaceJson(
      `/api/projects/${encodeURIComponent(projectId)}/canvases`,
    ),
  );
  if (!list.success) throw new Error("画布列表不可用，请重新打开项目");
  const target =
    list.data.canvases.find((item) => item.isPrimary) ?? list.data.canvases[0];
  if (target) return { documentId: target.id, title: target.name };
  const created = canvasGetResponseSchema.safeParse(
    await surfaceJson(
      `/api/projects/${encodeURIComponent(projectId)}/canvases`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "未命名画布",
          requestId: crypto.randomUUID(),
        }),
      },
    ),
  );
  if (!created.success || created.data.canvas.projectId !== projectId)
    throw new Error("画布创建失败，请重试");
  return {
    documentId: created.data.canvas.id,
    title: created.data.canvas.name,
  };
}
