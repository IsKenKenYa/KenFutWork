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
  const [ready, setReady] = useState(false);
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
    setReady(false);
    const active = installCanvasDocumentBridge({
      projectId: tab.projectId,
      canvasId: tab.documentId,
      target: () => frame.current?.contentWindow ?? null,
      onContext: (value) => {
        context.current = value;
        setReady(true);
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
          setReady(false);
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
  return { frame, ready, bindTask, prepare };
}

function useCanvasDocumentActions(
  { tab, isVisible }: DocumentPaneRendererProps,
  prepare: () => Promise<string>,
) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [name, setName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
    name: string;
    requestId: string;
  } | null>(null);
  useEffect(() => {
    life.current.alive = true;
    return () => {
      life.current.alive = false;
    };
  }, []);
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
        life.current.alive &&
        life.current.projectId === tab.projectId &&
        version === listVersion.current
      ) {
        setCanvases(response.data.canvases);
        setError(null);
      }
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
  useEffect(() => {
    setConfirmingDelete(false);
  }, [tab.documentId, isVisible]);
  const selected = canvases.find((item) => item.id === tab.documentId);
  useEffect(() => {
    if (isVisible && tab.documentId && selected && selected.name !== tab.title)
      requestCanvasDocumentOpen({
        projectId: tab.projectId,
        documentId: tab.documentId,
        title: selected.name,
      });
  }, [isVisible, selected, tab.documentId, tab.projectId, tab.title]);
  const run = async (
    operation: (foreground: () => boolean) => Promise<void>,
  ) => {
    if (busyRef.current || !isVisible) return;
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
  };
  const create = () =>
    run(async (foreground) => {
      const requestedName = name.trim() || "未命名画布";
      let request = pendingCreate.current;
      if (
        !request ||
        request.projectId !== tab.projectId ||
        request.name !== requestedName
      )
        request = {
          projectId: tab.projectId,
          name: requestedName,
          requestId: crypto.randomUUID(),
        };
      pendingCreate.current = request;
      const parsed = canvasGetResponseSchema.safeParse(
        await surfaceJson(
          `/api/projects/${encodeURIComponent(tab.projectId)}/canvases`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: request.name,
              requestId: request.requestId,
            }),
          },
        ),
      );
      if (!parsed.success || parsed.data.canvas.projectId !== tab.projectId)
        throw new Error("画布创建结果不可用，请重新打开项目");
      pendingCreate.current = null;
      if (foreground()) {
        setName("");
        requestCanvasDocumentOpen({
          projectId: tab.projectId,
          documentId: parsed.data.canvas.id,
          title: parsed.data.canvas.name,
        });
      }
      await list();
    });
  const rename = () =>
    run(async (foreground) => {
      if (!tab.documentId || !selected || !name.trim()) return;
      const revision = await prepare();
      const parsed = canvasGetResponseSchema.safeParse(
        await surfaceJson(
          `/api/canvases/${encodeURIComponent(tab.documentId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              expectedName: selected.name,
              expectedRevision: revision,
            }),
          },
        ),
      );
      if (
        !parsed.success ||
        parsed.data.canvas.projectId !== tab.projectId ||
        parsed.data.canvas.id !== tab.documentId
      )
        throw new Error("画布命名结果不可用，请重新打开项目");
      if (life.current.alive)
        setCanvases((items) =>
          items.map((item) =>
            item.id === parsed.data.canvas.id
              ? { ...item, name: parsed.data.canvas.name }
              : item,
          ),
        );
      if (foreground()) {
        setName("");
        requestCanvasDocumentOpen({
          projectId: tab.projectId,
          documentId: tab.documentId,
          title: parsed.data.canvas.name,
        });
      }
      await list();
    });
  const remove = () => {
    if (!isVisible) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    return run(async () => {
      if (!tab.documentId) return;
      const revision = await prepare();
      await surfaceJson(`/api/canvases/${encodeURIComponent(tab.documentId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      clearCanvasConversationContext(tab.projectId, tab.documentId);
      window.dispatchEvent(
        new CustomEvent(CANVAS_DOCUMENT_DELETED_EVENT, {
          detail: { projectId: tab.projectId, canvasId: tab.documentId },
        }),
      );
      await list();
    });
  };
  return {
    canvases,
    error,
    busy,
    name,
    setName,
    confirmingDelete,
    selected,
    list,
    create,
    rename,
    remove,
  };
}

/** Canvas 插件提供编辑内容；会话、审批与模型执行属于共享 SessionPane。 */
export function CanvasDocumentView(props: DocumentPaneRendererProps) {
  const { tab, isVisible } = props;
  const host = useCanvasDocumentHost(props);
  const {
    canvases,
    error,
    busy,
    name,
    setName,
    confirmingDelete,
    selected,
    list,
    create,
    rename,
    remove,
  } = useCanvasDocumentActions(props, host.prepare);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap shrink-0 items-center gap-2 border-b border-border p-2">
        <select
          aria-label="画布"
          value={tab.documentId ?? ""}
          disabled={busy}
          onFocus={() => void list()}
          onChange={(event) => {
            const canvas = canvases.find(
              (item) => item.id === event.target.value,
            );
            if (canvas)
              requestCanvasDocumentOpen({
                projectId: tab.projectId,
                documentId: canvas.id,
                title: canvas.name,
              });
          }}
          className="min-w-0 flex-1 bg-background text-sm"
        >
          <option value="">选择画布</option>
          {canvases.map((canvas) => (
            <option key={canvas.id} value={canvas.id}>
              {canvas.name}
            </option>
          ))}
        </select>
        <input
          aria-label="画布名称"
          value={name}
          disabled={busy}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          className="w-28 bg-background text-sm"
          placeholder="画布名称"
        />
        <Button size="sm" disabled={busy} onClick={() => void create()}>
          新建画布
        </Button>
        {tab.documentId && (
          <>
            <Button
              size="sm"
              disabled={busy || !host.ready || !selected || !name.trim()}
              onClick={() => void rename()}
            >
              重命名
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !host.ready}
              onClick={() => void remove()}
            >
              {confirmingDelete ? "确认删除" : "删除"}
            </Button>
          </>
        )}
      </div>
      {error ? (
        <div role="alert" className="px-3 py-2 text-sm">
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
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-foreground-subtle">
          选择或新建画布
        </div>
      )}
    </div>
  );
}
