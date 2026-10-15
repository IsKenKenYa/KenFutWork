"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { CanvasContent } from "@kenfutwork/shared";
import { PanelsTopLeft } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PluginPanelButtons } from "@/lib/plugin-panels";
import { BrandKitModal } from "../../components/brand-kit-modal";
import { BrandKitSelector } from "../../components/brand-kit-selector";
import {
  CanvasEditor,
  type CanvasSelectedElement,
} from "../../components/canvas-editor";
import { CanvasEmptyHint } from "../../components/canvas-empty-hint";
import { CanvasInspector } from "../../components/canvas-inspector";
import { CanvasLogoMenu } from "../../components/canvas-logo-menu";
import { CanvasToolMenu } from "../../components/canvas-tool-menu";
import { EditableProjectName } from "../../components/editable-project-name";
import { LoadingScreen } from "../../components/loading-screen";
import { installHostWorkspaceActivity } from "../../components/workbench/zcode/host/workspaceActivity";
import { useWebSocket } from "../../hooks/use-websocket";
import {
  canvasWorkbenchUrl,
  createCanvasRefreshCoordinator,
  installCanvasEditorBridge,
} from "../../lib/canvas-editor-bridge";
import {
  ApiAccessError,
  ApiApplicationError,
  fetchCanvas,
  fetchProject,
  restoreCanvasAssets,
} from "../../lib/server-api";

function CanvasPageContent() {
  useEffect(() => installHostWorkspaceActivity(window.parent), []);
  const searchParams = useSearchParams();
  const canvasId = searchParams.get("id");
  const editorMode = searchParams.get("editor") === "1";
  const router = useRouter();
  const [canvasData, setCanvasData] = useState<{
    id: string;
    name: string;
    projectId: string;
    revision: string;
    content: CanvasContent;
  } | null>(null);
  const [remoteSnapshot, setRemoteSnapshot] = useState<{
    revision: string;
    content: CanvasContent;
  } | null>(null);
  const [canvasRevision, setCanvasRevision] = useState<string | null>(null);
  const canvasRevisionRef = useRef(canvasRevision);
  const prepareCanvasAssetOperationRef = useRef<{
    canvasId: string;
    prepare: () => Promise<string | null>;
  } | null>(null);
  const prepareCanvasAssetOperation = useCallback(async () => {
    const registered = prepareCanvasAssetOperationRef.current;
    if (!registered || activeCanvasIdRef.current !== registered.canvasId)
      return null;
    const revision = await registered.prepare();
    return activeCanvasIdRef.current === registered.canvasId ? revision : null;
  }, []);
  const registerCanvasAssetOperation = useCallback(
    (prepare: () => Promise<string | null>) => {
      if (canvasData)
        prepareCanvasAssetOperationRef.current = {
          canvasId: canvasData.id,
          prepare,
        };
    },
    [canvasData],
  );
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  const [brandKitOpen, setBrandKitOpen] = useState(false);
  const [projectName, setProjectName] = useState("未命名项目");
  const selectedCanvasElementsRef = useRef<CanvasSelectedElement[]>([]);
  const bridgeRef = useRef<ReturnType<typeof installCanvasEditorBridge> | null>(
    null,
  );
  const remoteSyncWaitersRef = useRef(new Map<string, () => void>());
  const activeCanvasIdRef = useRef(canvasId);
  activeCanvasIdRef.current = canvasData?.id === canvasId ? canvasId : null;
  const [excalidrawApi, setExcalidrawApi] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const accessToken = null;
  // 画布截图 RPC 仍由真实编辑器提供；会话运行与消息由共享宿主持有。
  const ws = useWebSocket({ documentScope: canvasId ?? undefined });

  const handleRevisionChanged = useCallback((revision: string) => {
    canvasRevisionRef.current = revision;
    setCanvasRevision(revision);
  }, []);
  const handleRemoteSnapshotHandled = useCallback((revision: string) => {
    setRemoteSnapshot((snapshot) =>
      snapshot?.revision === revision ? null : snapshot,
    );
    remoteSyncWaitersRef.current.get(revision)?.();
    remoteSyncWaitersRef.current.delete(revision);
  }, []);
  const markCanvasDeleted = useCallback((id: string, projectId: string) => {
    if (activeCanvasIdRef.current !== id) return;
    bridgeRef.current?.publishDocumentUpdated({
      type: "canvas.document.updated",
      canvasId: id,
      projectId,
      deleted: true,
    });
    activeCanvasIdRef.current = null;
    for (const resolve of remoteSyncWaitersRef.current.values()) resolve();
    remoteSyncWaitersRef.current.clear();
    setRemoteSnapshot(null);
    setCanvasData(null);
    setError("画布已删除，请选择其他画布");
  }, []);
  const refreshCanvas = useCallback(async () => {
    if (!canvasData || activeCanvasIdRef.current !== canvasData.id) return;
    let canvas: Awaited<ReturnType<typeof fetchCanvas>>["canvas"];
    try {
      ({ canvas } = await fetchCanvas(accessToken, canvasData.id));
    } catch (error) {
      if (
        error instanceof ApiApplicationError &&
        error.code === "canvas_not_found"
      ) {
        markCanvasDeleted(canvasData.id, canvasData.projectId);
        return;
      }
      throw error;
    }
    if (activeCanvasIdRef.current !== canvasData.id) return;
    if (canvas.projectId !== canvasData.projectId)
      throw new Error("画布所属项目已变更，请重新打开");
    if (canvas.revision === canvasRevisionRef.current) return;
    await new Promise<void>((resolve) => {
      remoteSyncWaitersRef.current.set(canvas.revision, resolve);
      setRemoteSnapshot({
        revision: canvas.revision,
        content: {
          elements: canvas.content.elements ?? [],
          appState: canvas.content.appState ?? {},
          files: canvas.content.files ?? {},
        },
      });
    });
  }, [canvasData, markCanvasDeleted]);
  const refreshCanvasRef = useRef(refreshCanvas);
  refreshCanvasRef.current = refreshCanvas;
  const refreshCoordinatorRef = useRef<ReturnType<
    typeof createCanvasRefreshCoordinator
  > | null>(null);
  useEffect(() => {
    activeCanvasIdRef.current = canvasId;
    const coordinator = createCanvasRefreshCoordinator(() => {
      if (activeCanvasIdRef.current !== canvasId) return Promise.resolve();
      return refreshCanvasRef.current();
    });
    refreshCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (refreshCoordinatorRef.current === coordinator)
        refreshCoordinatorRef.current = null;
      if (activeCanvasIdRef.current === canvasId)
        activeCanvasIdRef.current = null;
      for (const resolve of remoteSyncWaitersRef.current.values()) resolve();
      remoteSyncWaitersRef.current.clear();
    };
  }, [canvasId]);
  const handleCanvasSync = useCallback(async () => {
    setSyncError(null);
    try {
      await refreshCoordinatorRef.current?.refresh();
    } catch (err) {
      setSyncError("画布同步失败，请重试");
      throw err;
    }
  }, []);
  useEffect(() => {
    if (!editorMode || !canvasData || !ws.connected) return;
    const targetId = canvasData.id;
    let active = true;
    const refresh = () => {
      if (active && activeCanvasIdRef.current === targetId)
        void handleCanvasSync().catch(() => {});
    };
    // 先监听再恢复订阅；ACK之后用文件事实补放，不接纳任何旧Task运行或媒体插入。
    const release = ws.onEvent((event) => {
      if (event.type === "canvas.sync") refresh();
    });
    const releaseDocuments = ws.onDocumentUpdated((message) => {
      if (
        !active ||
        activeCanvasIdRef.current !== targetId ||
        message.canvasId !== targetId ||
        message.projectId !== canvasData.projectId
      )
        return;
      if (message.deleted) {
        markCanvasDeleted(targetId, canvasData.projectId);
      } else {
        bridgeRef.current?.publishDocumentUpdated(message);
        refresh();
      }
    });
    ws.resumeCanvas(targetId, (ack) => {
      if (!active || activeCanvasIdRef.current !== targetId) return;
      if (
        ack.payload.status !== "rejected" &&
        ack.payload.canvasId === targetId
      )
        refresh();
      else setSyncError("画布订阅失败，请重新打开");
    });
    return () => {
      active = false;
      release();
      releaseDocuments();
    };
  }, [
    canvasData,
    editorMode,
    handleCanvasSync,
    markCanvasDeleted,
    ws.connected,
    ws.onEvent,
    ws.onDocumentUpdated,
    ws.resumeCanvas,
  ]);
  const handleRestoreCanvasAssets = useCallback(async () => {
    if (!canvasData) throw new Error("画布尚未加载，请稍后重试");
    const revision = await prepareCanvasAssetOperation();
    if (!revision) throw new Error("画布保存失败，未恢复素材");
    await restoreCanvasAssets(accessToken, canvasData.id, revision);
    await handleCanvasSync();
  }, [canvasData, handleCanvasSync, prepareCanvasAssetOperation]);

  useEffect(() => {
    if (!editorMode || !canvasData) return;
    const bridge = installCanvasEditorBridge({
      target: { canvasId: canvasData.id, projectId: canvasData.projectId },
      parent: window.parent,
      origin: window.location.origin,
      events: window,
      onRefresh: () => {
        void handleCanvasSync().catch(() => {});
      },
      onSessionChange: setActiveTaskId,
      onPrepare: prepareCanvasAssetOperation,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
  }, [canvasData, editorMode, handleCanvasSync, prepareCanvasAssetOperation]);
  useEffect(() => {
    bridgeRef.current?.publishContext(
      selectedCanvasElementsRef.current,
      brandKitId,
    );
  }, [brandKitId, canvasData, prepareCanvasAssetOperation]);
  const handleSelectionChange = useCallback(
    (elements: CanvasSelectedElement[]) => {
      selectedCanvasElementsRef.current = elements;
      bridgeRef.current?.publishContext(elements, brandKitId);
    },
    [brandKitId],
  );
  const handleOpenSession = useCallback(
    () => bridgeRef.current?.focusSession(),
    [],
  );
  const handleNewProject = useCallback(
    () => bridgeRef.current?.requestProject(),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    if (!canvasId) {
      if (!editorMode) router.replace(canvasWorkbenchUrl());
      else {
        setError("请从项目中打开画布");
        setPageLoading(false);
      }
      return;
    }
    setPageLoading(true);
    setError(null);
    setSyncError(null);
    setCanvasData(null);
    setActiveTaskId(null);
    setBrandKitId(null);
    prepareCanvasAssetOperationRef.current = null;
    selectedCanvasElementsRef.current = [];
    fetchCanvas(accessToken, canvasId)
      .then(async ({ canvas }) => {
        if (cancelled) return;
        if (!editorMode) {
          router.replace(
            canvasWorkbenchUrl({
              canvasId: canvas.id,
              projectId: canvas.projectId,
            }),
          );
          return;
        }
        setCanvasData({
          ...canvas,
          content: {
            elements: canvas.content.elements ?? [],
            appState: canvas.content.appState ?? {},
            files: canvas.content.files ?? {},
          },
        });
        handleRevisionChanged(canvas.revision);
        setPageLoading(false);
        try {
          const { project } = await fetchProject(accessToken, canvas.projectId);
          if (cancelled) return;
          setBrandKitId(project.brand_kit_id);
          setProjectName(project.name ?? "未命名项目");
        } catch (err) {
          if (!cancelled)
            console.warn("Failed to fetch project for brand kit:", err);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiAccessError
            ? "无法打开画布，请检查本机访问权限"
            : "画布加载失败，请重新打开",
        );
        setPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canvasId, editorMode, handleRevisionChanged, router]);

  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  if (!editorMode || pageLoading) return <LoadingScreen />;
  if (!canvasData) return null;

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
        <CanvasLogoMenu
          accessToken={accessToken}
          projectId={canvasData.projectId}
          canvasId={canvasData.id}
          onCanvasSync={handleCanvasSync}
          prepareCanvas={prepareCanvasAssetOperation}
          onNewProject={handleNewProject}
          projectName={projectName}
          excalidrawApi={excalidrawApi}
        />
        <EditableProjectName
          accessToken={accessToken}
          projectId={canvasData.projectId}
          initialName={projectName}
        />
        <BrandKitSelector
          accessToken={accessToken}
          projectId={canvasData.projectId}
          currentBrandKitId={brandKitId}
          onBrandKitChange={setBrandKitId}
          onManage={() => setBrandKitOpen(true)}
        />
        <PluginPanelButtons
          mode="design"
          accessToken={accessToken}
          slot="canvas"
          renderButton={(panel, open) => (
            <button
              key={panel.id}
              type="button"
              onClick={open}
              title={`插件 ${panel.pluginId} 提供的面板`}
              className="flex items-center gap-1.5 rounded-lg border-[0.5px] border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground"
            >
              <PanelsTopLeft className="h-3.5 w-3.5" />
              {panel.title}
            </button>
          )}
        />
      </div>
      <div className="relative min-w-0 flex-1 overflow-hidden">
        <CanvasEditor
          key={canvasData.id}
          canvasId={canvasData.id}
          projectId={canvasData.projectId}
          revision={canvasRevision ?? canvasData.revision}
          accessToken={accessToken}
          initialContent={canvasData.content}
          remoteSnapshot={remoteSnapshot}
          onRemoteSnapshotHandled={handleRemoteSnapshotHandled}
          onRevisionChanged={handleRevisionChanged}
          onPrepareAssetOperation={registerCanvasAssetOperation}
          onApiReady={setExcalidrawApi}
          ws={ws}
          onSelectionChange={handleSelectionChange}
          overlay={
            <CanvasEmptyHint
              excalidrawApi={excalidrawApi}
              onOpenChat={handleOpenSession}
            />
          }
        />
        {excalidrawApi && (
          <CanvasToolMenu
            canvasId={canvasData.id}
            projectId={canvasData.projectId}
            prepare={prepareCanvasAssetOperation}
            refresh={refreshCanvas}
            accessToken={accessToken}
            excalidrawApi={excalidrawApi}
            sessionId={activeTaskId ?? undefined}
          />
        )}
        <CanvasInspector
          canvasId={canvasData.id}
          prepareCanvasAssetOperation={prepareCanvasAssetOperation}
          excalidrawApi={excalidrawApi}
          accessToken={accessToken}
          onCanvasSync={handleCanvasSync}
          onRestoreAssets={handleRestoreCanvasAssets}
        />
        {syncError && (
          <p
            role="alert"
            className="absolute bottom-3 left-3 z-20 rounded-md bg-card px-3 py-2 text-sm text-destructive"
          >
            {syncError}
          </p>
        )}
      </div>
      <BrandKitModal
        open={brandKitOpen}
        onClose={() => setBrandKitOpen(false)}
      />
    </div>
  );
}

export default function CanvasPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CanvasPageContent />
    </Suspense>
  );
}
