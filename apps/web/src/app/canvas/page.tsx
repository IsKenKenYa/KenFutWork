"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  CanvasContent,
  ImageArtifact,
  VideoArtifact,
} from "@kenfutwork/shared";
import { PanelsTopLeft } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PluginPanelButtons } from "@/lib/plugin-panels";
import { BrandKitModal } from "../../components/brand-kit-modal";
import { BrandKitSelector } from "../../components/brand-kit-selector";
import type { CanvasSelectedElement } from "../../components/canvas-editor";
import { CanvasEditor } from "../../components/canvas-editor";
import { CanvasEmptyHint } from "../../components/canvas-empty-hint";
import { CanvasFilesPanel } from "../../components/canvas-files-panel";
import type { CanvasImageItem } from "../../components/canvas-image-picker";
import { CanvasLayersPanel } from "../../components/canvas-layers-panel";
import { CanvasLogoMenu } from "../../components/canvas-logo-menu";
import { CanvasToolMenu } from "../../components/canvas-tool-menu";
import { ChatSidebar, type SidePanelTab } from "../../components/chat-sidebar";
import { EditableProjectName } from "../../components/editable-project-name";
import { LoadingScreen } from "../../components/loading-screen";
import { installHostWorkspaceActivity } from "../../components/workbench/zcode/host/workspaceActivity";
import { useJobFallbackPolling } from "../../hooks/use-job-fallback-polling";
import { useWebSocket } from "../../hooks/use-websocket";
import {
  insertImageOnCanvas,
  insertVideoOnCanvas,
} from "../../lib/canvas-elements";
import {
  ApiAccessError,
  fetchCanvas,
  fetchProject,
  restoreCanvasAssets,
} from "../../lib/server-api";

function CanvasPageContent() {
  useEffect(() => installHostWorkspaceActivity(window.parent), []);
  const searchParams = useSearchParams();
  const canvasId = searchParams.get("id");
  const initialSessionId = searchParams.get("session") ?? undefined;
  // Capture prompt once — router.replace will strip it from URL, but the
  // value must survive for the auto-send effect in ChatSidebar.
  const [initialPrompt] = useState(
    () => searchParams.get("prompt") ?? undefined,
  );
  const router = useRouter();

  const [canvasData, setCanvasData] = useState<{
    id: string;
    name: string;
    projectId: string;
    revision: string;
    content: {
      elements: Record<string, unknown>[];
      appState: Record<string, unknown>;
      files: Record<string, Record<string, unknown>>;
    };
  } | null>(null);
  const [remoteSnapshot, setRemoteSnapshot] = useState<{
    revision: string;
    content: CanvasContent;
  } | null>(null);
  const [canvasRevision, setCanvasRevision] = useState<string | null>(null);
  const [prepareCanvasAssetOperation, setPrepareCanvasAssetOperation] =
    useState<() => Promise<string | null>>(() => async () => null);
  const registerCanvasAssetOperation = useCallback(
    (prepare: () => Promise<string | null>) =>
      setPrepareCanvasAssetOperation(() => prepare),
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  // Default chat open on desktop, closed on mobile/tablet to avoid blocking canvas
  const [chatOpen, setChatOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= 1024;
  });
  /**
   * 右侧面板的标签：会话 / 图层 / 文件。
   *
   * 图层与生成文件原先各自是画布上的一层浮层（`fixed left-0` + 自己的标题栏），
   * 与右侧助手面板三足鼎立：同一块信息分散在三处、画布还常被浮层压住。现在只有
   * 一个右侧面板，三者是它的三个标签。
   */
  const [panelTab, setPanelTab] = useState<SidePanelTab>("chat");
  /** 当前画布会话：由聊天侧栏回调更新（URL 只作初始值），供生成类工具渲染自定义头占位符。 */
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(
    initialSessionId,
  );
  const [brandKitId, setBrandKitId] = useState<string | null>(null);
  /** 品牌套件管理浮窗（90%×85%）——此前是导航到 /brand-kit，会把整页换掉。 */
  const [brandKitOpen, setBrandKitOpen] = useState(false);
  const [projectName, setProjectName] = useState("未命名画布");
  const [selectedCanvasElements, setSelectedCanvasElements] = useState<
    CanvasSelectedElement[]
  >([]);

  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const remoteSyncWaitersRef = useRef(new Map<string, () => void>());
  const [excalidrawApi, setExcalidrawApi] =
    useState<ExcalidrawImperativeAPI | null>(null);

  const routerRef = useRef(router);
  routerRef.current = router;

  // Stable callbacks for panel toggles to prevent re-renders of child components
  const handleOpenChat = useCallback(() => {
    setPanelTab("chat");
    setChatOpen(true);
  }, []);
  const handleToggleChat = useCallback(() => setChatOpen((v) => !v), []);

  const accessToken = null;
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  const ws = useWebSocket();

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawApiRef.current = api;
    setExcalidrawApi(api);
  }, []);

  const handleImageGenerated = useCallback((artifact: ImageArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    insertImageOnCanvas(api, artifact).catch((err) => {
      console.warn("Failed to insert image on canvas:", err);
    });
  }, []);

  const handleVideoGenerated = useCallback((artifact: VideoArtifact) => {
    const api = excalidrawApiRef.current;
    if (!api) return;
    insertVideoOnCanvas(api, artifact).catch((err) => {
      console.warn("Failed to insert video on canvas:", err);
    });
  }, []);

  // Must be defined BEFORE useJobFallbackPolling which references it
  const handleRemoteSnapshotHandled = useCallback((revision: string) => {
    setRemoteSnapshot((snapshot) =>
      snapshot?.revision === revision ? null : snapshot,
    );
    remoteSyncWaitersRef.current.get(revision)?.();
    remoteSyncWaitersRef.current.delete(revision);
  }, []);

  const handleCanvasSync = useCallback(async () => {
    const token = accessTokenRef.current;
    if (!canvasData) return;
    try {
      const { canvas } = await fetchCanvas(token, canvasData.id);
      if (canvas.revision === canvasRevision) return;
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
    } catch (err) {
      console.warn("Failed to sync canvas:", err);
    }
  }, [canvasData, canvasRevision]);

  const handleRestoreCanvasAssets = useCallback(async () => {
    if (!canvasData) throw new Error("当前画布尚未加载。");
    const revision = await prepareCanvasAssetOperation();
    if (!revision) throw new Error("画布保存失败，未恢复素材。");
    await restoreCanvasAssets(accessTokenRef.current, canvasData.id, revision);
    await handleCanvasSync();
  }, [canvasData, handleCanvasSync, prepareCanvasAssetOperation]);

  // Fallback polling for timed-out generation jobs.
  // When the agent's tool times out but the worker eventually succeeds,
  // the backend will have already inserted the element into the canvas.
  // This hook detects completion and triggers a canvas re-fetch.
  const { checkForTimedOutJobs } = useJobFallbackPolling({
    accessTokenRef,
    onJobSucceeded: useCallback(
      (_jobId: string, _jobType: string) => {
        // Element was inserted by backend — just refresh the canvas
        handleCanvasSync();
      },
      [handleCanvasSync],
    ),
  });

  const handleSessionChange = useCallback(
    (sessionId: string) => {
      if (!canvasId) return;
      // 会话 id 同时留在状态里：生成类工具（图片/视频）要用它渲染实例自定义头的
      // {{sessionId}} 占位符（§4.8）——只改 URL 的话面板取不到（此前正是如此）。
      setActiveSessionId(sessionId);
      // Update URL: set session param, remove prompt param to prevent re-send on refresh
      routerRef.current.replace(`/canvas?id=${canvasId}&session=${sessionId}`);
    },
    [canvasId],
  );

  const handleRequestCanvasImages = useCallback((): CanvasImageItem[] => {
    const api = excalidrawApiRef.current;
    if (!api) return [];
    const files = api.getFiles() ?? {};
    const images: CanvasImageItem[] = [];
    let idx = 0;
    for (const el of api.getSceneElements() ?? []) {
      // 只有带 fileId 的 image 元素才是「画布图片」：fileId 是取 files 的键
      if (el.type !== "image" || el.isDeleted || !el.fileId) continue;
      idx++;
      const file = files[el.fileId];
      const dataURL = file?.dataURL ?? "";
      const title =
        el.customData?.title || el.customData?.label || `Image ${idx}`;
      images.push({
        kind: "canvas-image",
        id: el.id,
        name: title,
        thumbnailUrl: dataURL,
        assetId: el.id,
        url: dataURL,
        mimeType: file?.mimeType ?? "image/png",
      });
    }
    return images;
  }, []);

  useEffect(() => {
    const token = accessTokenRef.current;
    if (!canvasId) return;

    setPageLoading(true);
    fetchCanvas(token, canvasId)
      .then((data) => {
        const c = data.canvas;
        setCanvasData({
          id: c.id,
          name: c.name,
          projectId: c.projectId,
          revision: c.revision,
          content: {
            elements: c.content.elements ?? [],
            appState: c.content.appState ?? {},
            files: c.content.files ?? {},
          },
        });
        setCanvasRevision(c.revision);
        setPageLoading(false);
        // Fetch project to get brand_kit_id and name
        fetchProject(token, c.projectId)
          .then((projectData) => {
            setBrandKitId(projectData.project.brand_kit_id);
            setProjectName(projectData.project.name ?? "未命名画布");
          })
          .catch((err) =>
            console.warn("Failed to fetch project for brand kit:", err),
          );
      })
      .catch((err) => {
        if (err instanceof ApiAccessError) {
          return;
        }
        setError("Failed to load canvas.");
        setPageLoading(false);
      });
  }, [canvasId]);

  if (!canvasId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">No canvas ID specified.</p>
      </div>
    );
  }

  if (pageLoading) {
    return <LoadingScreen />;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!canvasData) return null;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Top-left navigation bar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5">
        <CanvasLogoMenu
          accessToken={accessToken}
          projectId={canvasData.projectId}
          canvasId={canvasData.id}
          onCanvasSync={handleCanvasSync}
          prepareCanvas={prepareCanvasAssetOperation}
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
          onBrandKitChange={(kitId) => setBrandKitId(kitId)}
          onManage={() => setBrandKitOpen(true)}
        />
        {/* 插件面板（能力 `ui`）：画布槽位 */}
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
      {/* Canvas always takes full width; on mobile/tablet, ChatSidebar overlays instead of side-by-side */}
      <div className="flex-1 relative min-w-0 overflow-hidden">
        <CanvasEditor
          key={canvasData.id}
          canvasId={canvasData.id}
          projectId={canvasData.projectId}
          revision={canvasRevision ?? canvasData.revision}
          accessToken={accessToken}
          initialContent={canvasData.content}
          remoteSnapshot={remoteSnapshot}
          onRemoteSnapshotHandled={handleRemoteSnapshotHandled}
          onRevisionChanged={setCanvasRevision}
          onPrepareAssetOperation={registerCanvasAssetOperation}
          onApiReady={handleApiReady}
          ws={ws}
          onSelectionChange={setSelectedCanvasElements}
          overlay={
            <CanvasEmptyHint
              excalidrawApi={excalidrawApi}
              onOpenChat={handleOpenChat}
            />
          }
        />
        {excalidrawApi && (
          <CanvasToolMenu
            accessToken={accessToken}
            excalidrawApi={excalidrawApi}
            sessionId={activeSessionId}
          />
        )}
      </div>
      <ChatSidebar
        accessToken={accessToken}
        canvasId={canvasData.id}
        open={chatOpen}
        onToggle={handleToggleChat}
        onImageGenerated={handleImageGenerated}
        onVideoGenerated={handleVideoGenerated}
        onCanvasSync={handleCanvasSync}
        onStreamEvent={checkForTimedOutJobs}
        initialPrompt={initialPrompt}
        initialSessionId={initialSessionId}
        onSessionChange={handleSessionChange}
        onRequestCanvasImages={handleRequestCanvasImages}
        currentBrandKitId={brandKitId}
        ws={ws}
        selectedCanvasElements={selectedCanvasElements}
        panelTab={panelTab}
        onPanelTabChange={setPanelTab}
        layersPanel={
          <CanvasLayersPanel
            excalidrawApi={excalidrawApi}
            active={panelTab === "layers"}
          />
        }
        filesPanel={
          <CanvasFilesPanel
            canvasId={canvasData.id}
            prepareCanvasAssetOperation={prepareCanvasAssetOperation}
            excalidrawApi={excalidrawApi}
            active={panelTab === "files"}
            accessToken={accessToken}
            onCanvasSync={handleCanvasSync}
            onRestoreAssets={handleRestoreCanvasAssets}
          />
        }
      />
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
