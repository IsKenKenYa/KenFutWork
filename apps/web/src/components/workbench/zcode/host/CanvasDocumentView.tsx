import {
  type CanvasSummary,
  canvasGetResponseSchema,
  canvasListResponseSchema,
} from "@kenfutwork/shared";
import type { ConversationWorkContext } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@zui/components/ui/button.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { installCanvasDocumentBridge } from "./canvasDocumentBridge.js";
import {
  CANVAS_DOCUMENT_DELETED_EVENT,
  CANVAS_DOCUMENT_UPDATED_EVENT,
} from "./canvasDocumentNavigation.js";
import {
  clearCanvasConversationContext,
  requestCanvasDocumentOpen,
  setCanvasConversationContext,
} from "./conversationWorkContext.js";
import type { DocumentPaneRendererProps } from "./DocumentPane.js";
import { surfaceJson } from "./surfaceApi.js";

/** 画布 iframe 里的「三条杠」菜单请求宿主建/删画布（数据与保存版本只有宿主拿得到）。 */
export const CANVAS_CREATE_REQUEST_EVENT = "kenfutwork:canvas-create";
export const CANVAS_DELETE_REQUEST_EVENT = "kenfutwork:canvas-delete";

function useCanvasDocumentHost({
  tab,
  isVisible,
  activeTaskId,
}: DocumentPaneRendererProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof installCanvasDocumentBridge> | null>(
    null,
  );
  const current = useRef({ isVisible, activeTaskId, tab });
  current.current = { isVisible, activeTaskId, tab };
  const context = useRef<ConversationWorkContext | null>(null);
  const documentDeleted = useRef(false);
  const bindTask = useCallback(
    () =>
      bridge.current?.bindTask(
        current.current.activeTaskId,
        current.current.isVisible,
      ),
    [],
  );
  const publishContext = useCallback(() => {
    const { isVisible: visible, tab: target } = current.current;
    if (!documentDeleted.current && visible && target.documentId)
      setCanvasConversationContext(target.projectId, {
        canvasId: target.documentId,
        title: target.title,
        ...(context.current?.selectedCanvasElements
          ? { selectedCanvasElements: context.current.selectedCanvasElements }
          : {}),
        ...(context.current?.brandKitId
          ? { brandKitId: context.current.brandKitId }
          : {}),
      });
  }, []);
  useEffect(() => {
    if (!tab.documentId) return;
    context.current = null;
    documentDeleted.current = false;
    const active = installCanvasDocumentBridge({
      projectId: tab.projectId,
      canvasId: tab.documentId,
      target: () => frame.current?.contentWindow ?? null,
      onContext: (value) => {
        context.current = value;
        publishContext();
        bindTask();
      },
      onFocus: () => {
        if (current.current.isVisible)
          window.dispatchEvent(new Event("kenfutwork:focus-session"));
      },
      onNewProject: () => {
        if (current.current.isVisible)
          window.dispatchEvent(new Event("kenfutwork:new-project"));
      },
      onCreateCanvas: () => {
        if (current.current.isVisible)
          window.dispatchEvent(new Event(CANVAS_CREATE_REQUEST_EVENT));
      },
      onDeleteCanvas: () => {
        if (current.current.isVisible)
          window.dispatchEvent(new Event(CANVAS_DELETE_REQUEST_EVENT));
      },
      onProjectDeleted: () =>
        window.dispatchEvent(
          new CustomEvent("kenfutwork:project-deleted", {
            detail: { projectId: tab.projectId },
          }),
        ),
      onDocumentUpdated: (message) => {
        if (message.deleted) {
          documentDeleted.current = true;
          context.current = null;
          clearCanvasConversationContext(message.projectId, message.canvasId);
        }
        window.dispatchEvent(
          new CustomEvent(
            message.deleted
              ? CANVAS_DOCUMENT_DELETED_EVENT
              : CANVAS_DOCUMENT_UPDATED_EVENT,
            { detail: message },
          ),
        );
      },
    });
    bridge.current = active;
    return () => {
      active.dispose();
      if (bridge.current === active) bridge.current = null;
    };
  }, [bindTask, publishContext, tab.documentId, tab.projectId]);
  useEffect(() => {
    bindTask();
    publishContext();
    return () => {
      if (tab.documentId)
        clearCanvasConversationContext(tab.projectId, tab.documentId);
    };
  }, [
    bindTask,
    publishContext,
    isVisible,
    activeTaskId,
    tab.documentId,
    tab.projectId,
    tab.title,
  ]);
  const prepare = useCallback(
    () =>
      bridge.current?.prepare() ?? Promise.reject(new Error("请先打开画布")),
    [],
  );
  return { frame, bindTask, prepare };
}

function useCanvasDocumentActions(
  { tab, isVisible }: DocumentPaneRendererProps,
  prepare: () => Promise<string>,
) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const life = useRef({
    alive: true,
    projectId: tab.projectId,
    visible: isVisible,
    version: 0,
  });
  if (
    life.current.visible !== isVisible ||
    life.current.projectId !== tab.projectId
  )
    life.current.version++;
  life.current.projectId = tab.projectId;
  life.current.visible = isVisible;
  const listVersion = useRef(0);
  const pendingCreate = useRef<{
    projectId: string;
    requestId: string;
  } | null>(null);
  useEffect(() => {
    life.current.alive = true;
    return () => {
      life.current.alive = false;
    };
  }, []);
  /** 列表落定的项目：默认打开只在此之后判定一次。 */
  const [loaded, setLoaded] = useState<string | null>(null);
  const list = useCallback(async () => {
    const version = ++listVersion.current;
    try {
      const response = canvasListResponseSchema.safeParse(
        await surfaceJson(
          `/api/projects/${encodeURIComponent(tab.projectId)}/canvases`,
        ),
      );
      if (!response.success) throw new Error("画布列表不可用，请重新打开项目");
      if (
        !life.current.alive ||
        life.current.projectId !== tab.projectId ||
        version !== listVersion.current
      )
        return;
      setCanvases(response.data.canvases);
      setError(null);
      setLoaded(tab.projectId);
    } catch (failure) {
      if (
        life.current.alive &&
        life.current.projectId === tab.projectId &&
        version === listVersion.current
      )
        setError(
          failure instanceof Error
            ? failure.message
            : "无法读取画布，请重新打开项目",
        );
    }
  }, [tab.projectId]);
  useEffect(() => {
    if (isVisible) void list();
  }, [isVisible, list]);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId === tab.projectId) void list();
    };
    window.addEventListener(CANVAS_DOCUMENT_UPDATED_EVENT, update);
    window.addEventListener(CANVAS_DOCUMENT_DELETED_EVENT, update);
    return () => {
      window.removeEventListener(CANVAS_DOCUMENT_UPDATED_EVENT, update);
      window.removeEventListener(CANVAS_DOCUMENT_DELETED_EVENT, update);
    };
  }, [list, tab.projectId]);
  const selected = canvases.find((item) => item.id === tab.documentId);
  useEffect(() => {
    if (isVisible && tab.documentId && selected && selected.name !== tab.title)
      requestCanvasDocumentOpen({
        projectId: tab.projectId,
        documentId: tab.documentId,
        title: selected.name,
      });
  }, [isVisible, selected, tab.documentId, tab.projectId, tab.title]);
  const run = useCallback(
    async (operation: (foreground: () => boolean) => Promise<void>) => {
      if (busyRef.current || !life.current.visible) return;
      const generation = life.current.version;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const foreground = () =>
        life.current.alive &&
        life.current.projectId === tab.projectId &&
        life.current.visible &&
        life.current.version === generation;
      try {
        await operation(foreground);
      } catch (failure) {
        if (life.current.alive && life.current.projectId === tab.projectId)
          setError(
            failure instanceof Error ? failure.message : "操作失败，请重试",
          );
      } finally {
        busyRef.current = false;
        if (life.current.alive) setBusy(false);
      }
    },
    [tab.projectId],
  );
  const create = useCallback(
    () =>
      run(async (foreground) => {
        const requested = pendingCreate.current;
        const request =
          requested && requested.projectId === tab.projectId
            ? requested
            : { projectId: tab.projectId, requestId: crypto.randomUUID() };
        pendingCreate.current = request;
        const parsed = canvasGetResponseSchema.safeParse(
          await surfaceJson(
            `/api/projects/${encodeURIComponent(tab.projectId)}/canvases`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: "未命名画布",
                requestId: request.requestId,
              }),
            },
          ),
        );
        if (!parsed.success || parsed.data.canvas.projectId !== tab.projectId)
          throw new Error("画布创建结果不可用，请重新打开项目");
        pendingCreate.current = null;
        if (foreground())
          requestCanvasDocumentOpen({
            projectId: tab.projectId,
            documentId: parsed.data.canvas.id,
            title: parsed.data.canvas.name,
          });
        await list();
      }),
    [list, run, tab.projectId],
  );
  /**
   * 「该打开哪个画布」由宿主在开标签之前敲定（见 `ensureDesignCanvasEntry`）。
   * 这里不再自行请求：视图一旦在标签已存在时再 requestCanvasDocumentOpen，
   * 宿主会按 documentId 另开一个标签，于是并排出现空白的「画布」和真正的画布。
   */
  const remove = useCallback(
    () =>
      run(async () => {
        if (!tab.documentId) return;
        const revision = await prepare();
        await surfaceJson(
          `/api/canvases/${encodeURIComponent(tab.documentId)}`,
          {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedRevision: revision }),
          },
        );
        clearCanvasConversationContext(tab.projectId, tab.documentId);
        window.dispatchEvent(
          new CustomEvent(CANVAS_DOCUMENT_DELETED_EVENT, {
            detail: { projectId: tab.projectId, canvasId: tab.documentId },
          }),
        );
        await list();
      }),
    [list, prepare, run, tab.documentId, tab.projectId],
  );
  return {
    error,
    busy,
    create,
    remove,
    /**
     * 列表是否已落定（成功或失败）。未落定前不能下「还没有画布」的结论，
     * 否则每次进 Design 都会先闪一帧空态、再被默认打开的画布顶掉。
     */
    listSettled: loaded === tab.projectId || error !== null,
    hasCanvases: canvases.length > 0,
  };
}

/** Canvas 插件提供编辑内容；会话、审批与模型执行属于共享 SessionPane。 */
export function CanvasDocumentView(props: DocumentPaneRendererProps) {
  const { tab, isVisible } = props;
  const host = useCanvasDocumentHost(props);
  const { error, busy, create, remove, listSettled, hasCanvases } =
    useCanvasDocumentActions(props, host.prepare);
  const live = useRef({ create, remove });
  live.current = { create, remove };
  useEffect(() => {
    const onRequestCreate = () => void live.current.create();
    const onRequestDelete = () => void live.current.remove();
    window.addEventListener(CANVAS_CREATE_REQUEST_EVENT, onRequestCreate);
    window.addEventListener(CANVAS_DELETE_REQUEST_EVENT, onRequestDelete);
    return () => {
      window.removeEventListener(CANVAS_CREATE_REQUEST_EVENT, onRequestCreate);
      window.removeEventListener(CANVAS_DELETE_REQUEST_EVENT, onRequestDelete);
    };
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {error ? (
        <div role="alert" className="shrink-0 px-3 py-2 text-sm">
          {error}
        </div>
      ) : null}
      {tab.documentId ? (
        <iframe
          ref={host.frame}
          onLoad={host.bindTask}
          src={`/canvas?id=${encodeURIComponent(tab.documentId)}&editor=1`}
          title={tab.title}
          inert={!isVisible}
          tabIndex={isVisible ? 0 : -1}
          className="min-h-0 flex-1 border-0"
        />
      ) : listSettled && !hasCanvases ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-foreground-subtle">
          <p>还没有画布</p>
          <Button size="sm" disabled={busy} onClick={() => void create()}>
            新建画布
          </Button>
        </div>
      ) : (
        // 列表在途、或已落定但默认画布还没接上：留白，不抢一帧空态。
        <div className="min-h-0 flex-1 bg-background" />
      )}
    </div>
  );
}
