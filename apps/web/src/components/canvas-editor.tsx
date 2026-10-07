"use client";

import { bearerHeaders, serverFetch } from "@/lib/local-access";

import "@excalidraw/excalidraw/index.css";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { CaptureUpdateActionType } from "@excalidraw/excalidraw/store";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WebSocketHandle } from "../hooks/use-websocket";
import { isVideoUrl } from "../lib/canvas-elements";
import { normalizeCanvasElements } from "../lib/canvas-normalize";
import { shouldRefuseEmptySave } from "../lib/canvas-save-guard";
import { getServerBaseUrl } from "../lib/env";
import { saveCanvas, uploadThumbnail } from "../lib/server-api";
import { VideoCanvasElement } from "./canvas/video-canvas-element";
import { CanvasStatsPanel } from "./canvas-stats-panel";
import { ErrorBoundary } from "./error-boundary";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((mod) => mod.Excalidraw),
  { ssr: false },
);

// Safari <16.4 does not support requestIdleCallback — provide a fallback
// that defers via setTimeout(cb, 1) to approximate idle scheduling.
const ric: typeof requestIdleCallback =
  typeof window !== "undefined" && window.requestIdleCallback
    ? window.requestIdleCallback.bind(window)
    : (cb: IdleRequestCallback) => setTimeout(cb, 1) as unknown as number;
const cic: typeof cancelIdleCallback =
  typeof window !== "undefined" && window.cancelIdleCallback
    ? window.cancelIdleCallback.bind(window)
    : clearTimeout;

export type CanvasSelectedElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fileId?: string;
  dataUrl?: string;
  /** Supabase storage public URL -- prefer over dataUrl for message attachments */
  storageUrl?: string;
};

/** 手动保存的结果：成功 / 没内容可存 / 真的失败——三者文案不同，别把空画布说成失败。 */
type SaveOutcome = "saved" | "empty" | "error";

type CanvasEditorProps = {
  canvasId: string;
  projectId: string;
  accessToken: string | null;
  initialContent: {
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  };
  onApiReady?: (api: ExcalidrawImperativeAPI) => void;
  /** 画布内覆盖层（渲染在 Excalidraw 内部：位于画布之上、其浮层之下）。 */
  overlay?: React.ReactNode;
  ws?: WebSocketHandle;
  onSelectionChange?: (elements: CanvasSelectedElement[]) => void;
};

const SAVE_DEBOUNCE_MS = 1500;
const THUMBNAIL_DEBOUNCE_MS = 10_000;
const THUMBNAIL_MAX_SIZE = 400;

export function CanvasEditor({
  canvasId,
  projectId,
  accessToken,
  initialContent,
  onApiReady,
  overlay,
  ws,
  onSelectionChange,
}: CanvasEditorProps) {
  const { resolvedTheme } = useTheme();
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbnailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const canvasIdRef = useRef(canvasId);
  canvasIdRef.current = canvasId;
  const [excalidrawApi, setExcalidrawApi] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const prevSelectedIdsRef = useRef<string>("");
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  // Tracks whether the one-time normalization pass has already run
  const normalizedRef = useRef(false);

  // Guard: prevent auto-save until Excalidraw has fully hydrated with initial data.
  // Without this, a page reload can fire onChange with empty elements before
  // initialData is applied, causing a FULL REPLACE that wipes existing content.
  const hydratedRef = useRef(false);

  // Track pending save payload so we can flush on tab close / unmount
  const pendingSaveRef = useRef<{
    elements: Record<string, unknown>[];
    appState: Record<string, unknown>;
    files: Record<string, Record<string, unknown>>;
  } | null>(null);

  // Ref to hold initialContent.files for storageUrl lookup in handleChange
  // without adding the full initialContent to the dependency array.
  const initialFilesRef = useRef(initialContent.files);
  initialFilesRef.current = initialContent.files;

  // Separate inline files (ready) from storage URLs (need async fetch)
  const { inlineFiles, pendingUrls } = useMemo(() => {
    const inline: Record<string, Record<string, unknown>> = {};
    const pending: Array<{
      fileId: string;
      url: string;
      meta: Record<string, unknown>;
    }> = [];
    for (const [fileId, fileData] of Object.entries(initialContent.files)) {
      if (typeof fileData.storageUrl === "string" && fileData.storageUrl) {
        pending.push({ fileId, url: fileData.storageUrl, meta: fileData });
      } else {
        inline[fileId] = fileData;
      }
    }
    return { inlineFiles: inline, pendingUrls: pending };
  }, [initialContent.files]);

  // Lazily resolve storage URLs and inject into Excalidraw
  useEffect(() => {
    if (!excalidrawApi || pendingUrls.length === 0) return;
    let cancelled = false;

    async function resolveFiles() {
      const resolved: Record<string, BinaryFileData> = {};
      await Promise.all(
        pendingUrls.map(async ({ fileId, url, meta }) => {
          try {
            const resp = await serverFetch(url);
            if (!resp.ok) {
              console.warn(
                `[canvas-editor] Failed to fetch file ${fileId}: ${resp.status}`,
              );
              return;
            }
            const blob = await resp.blob();
            const reader = new FileReader();
            const dataURL = await new Promise<string>((resolve, reject) => {
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            // id/mimeType/dataURL 在 Excalidraw 类型里是品牌字符串，这里的数据源是服务端
            // 文件元数据、真实 blob 与 FileReader 产物，字符串本身就是该品牌想约束的东西，
            // 故在边界处断言。
            resolved[fileId] = {
              id: (typeof meta.id === "string"
                ? meta.id
                : fileId) as BinaryFileData["id"],
              mimeType: (typeof meta.mimeType === "string"
                ? meta.mimeType
                : blob.type) as BinaryFileData["mimeType"],
              created:
                typeof meta.created === "number" ? meta.created : Date.now(),
              dataURL: dataURL as BinaryFileData["dataURL"],
            };
          } catch (err) {
            console.warn(
              `[canvas-editor] Failed to resolve file ${fileId}:`,
              err,
            );
          }
        }),
      );
      if (!cancelled && Object.keys(resolved).length > 0 && excalidrawApi) {
        excalidrawApi.addFiles(Object.values(resolved));
        console.log(
          `[canvas-editor] Resolved ${Object.keys(resolved).length} storage files`,
        );
      }
    }

    resolveFiles();
    return () => {
      cancelled = true;
    };
  }, [excalidrawApi, pendingUrls]);

  const handleExcalidrawApi = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      setExcalidrawApi(api);
      onApiReady?.(api);
    },
    [onApiReady],
  );

  // Normalize agent-created elements on initial load.
  // Uses DOM text measurement to fix server-side approximation errors.
  useEffect(() => {
    if (!excalidrawApi || normalizedRef.current) return;
    normalizedRef.current = true;

    // Run normalization after Excalidraw has loaded fonts.
    // Store the handle so we can cancel on unmount to prevent memory leaks.
    const idleHandle = ric(() => {
      try {
        const sceneElements = excalidrawApi.getSceneElements();
        // Create mutable copies for normalization
        const mutableElements = sceneElements.map((el) => ({ ...el }));
        const { changed } = normalizeCanvasElements(mutableElements);

        if (changed) {
          console.log("[canvas-editor] normalized agent-created elements");
          excalidrawApi.updateScene({
            elements: mutableElements,
            // 旧写法 "NONE" 不在 0.18 的捕获枚举（NEVER/IMMEDIATELY/EVENTUALLY）里，
            // 运行时不匹配任何分支、等价 EVENTUALLY；这里保持原值以免改变撤销栈行为。
            captureUpdate: "NONE" as CaptureUpdateActionType,
          });
          // Persist normalized elements to DB
          const files: Record<string, Record<string, unknown>> = {};
          const rawFiles = excalidrawApi.getFiles();
          for (const [id, file] of Object.entries(rawFiles)) {
            files[id] = {
              id: file.id,
              dataURL: file.dataURL,
              mimeType: file.mimeType,
              created: file.created,
            };
          }
          const appState = excalidrawApi.getAppState();
          saveCanvas(accessTokenRef.current, canvasIdRef.current, {
            elements: mutableElements.filter((el) => !el.isDeleted),
            appState: {
              viewBackgroundColor: appState.viewBackgroundColor,
              gridModeEnabled: appState.gridModeEnabled,
            },
            files,
          }).catch((err: Error) =>
            console.warn("[canvas-editor] normalization save failed:", err),
          );
        }
      } catch (err) {
        console.warn("[canvas-editor] normalization failed:", err);
      }

      // Mark hydrated after normalization — auto-save is now safe.
      // Before this point, onChange may fire with incomplete element lists
      // during Excalidraw's internal initialization, which would cause a
      // FULL REPLACE with empty content and silently wipe existing data.
      hydratedRef.current = true;
    });
    return () => cic(idleHandle);
  }, [excalidrawApi]);

  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState) => {
      // Skip auto-save until Excalidraw has fully hydrated with initial data.
      // During initialization, onChange may fire with empty/partial elements
      // which would wipe the persisted canvas via FULL REPLACE.
      if (!hydratedRef.current) return;

      // --- 1. Debounced save ---
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

      // Mark that a save is pending. The full payload is built lazily inside
      // the timeout to avoid constructing the files map on every drag frame.
      pendingSaveRef.current = { elements: [], appState: {}, files: {} };

      saveTimerRef.current = setTimeout(() => {
        // Build the full payload only when the debounce fires
        const files: Record<string, Record<string, unknown>> = {};
        if (excalidrawApi) {
          const rawFiles = excalidrawApi.getFiles();
          for (const [id, file] of Object.entries(rawFiles)) {
            files[id] = {
              id: file.id,
              dataURL: file.dataURL,
              mimeType: file.mimeType,
              created: file.created,
            };
          }
        }
        const content = {
          elements: elements.filter((el) => !el.isDeleted),
          appState: {
            viewBackgroundColor: appState.viewBackgroundColor,
            gridModeEnabled: appState.gridModeEnabled,
          },
          files,
        };

        // 空场景覆盖护栏（与卸载前 flush 共用同一判定）：空内容一律不写——整表替换下
        // 「写空」等于删光，而空场景本身没有可写的信息。实测吃过两次亏：挂载期 Excalidraw
        // 先回调一次空列表，以及同一画布在别处（工作台 iframe）也开着、那份空场景因焦点
        // 变化触发保存。判定收敛在纯函数里，两条写路径共用，别再各自漂移。
        if (shouldRefuseEmptySave({ incomingCount: content.elements.length })) {
          console.warn("[canvas-editor] 跳过空场景保存（空内容不写库）");
          pendingSaveRef.current = null;
          return;
        }
        pendingSaveRef.current = content;

        saveCanvas(accessTokenRef.current, canvasId, content)
          .then(() => {
            if (pendingSaveRef.current === content) {
              pendingSaveRef.current = null;
            }
          })
          .catch((err) => console.error("[canvas-editor] save failed:", err));
      }, SAVE_DEBOUNCE_MS);

      // --- 2. Debounced thumbnail (runs much less frequently than save) ---
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);
      thumbnailTimerRef.current = setTimeout(async () => {
        if (!excalidrawApi) return;
        try {
          const { exportToBlob } = await import("@excalidraw/excalidraw");
          const sceneElements = excalidrawApi.getSceneElements();
          const sceneFiles = excalidrawApi.getFiles();
          if (!sceneElements.length) return;

          const blob = await exportToBlob({
            elements: sceneElements,
            appState: { exportBackground: true },
            files: sceneFiles,
            mimeType: "image/webp",
            quality: 0.8,
            maxWidthOrHeight: THUMBNAIL_MAX_SIZE,
          });

          console.log(
            "[canvas-editor] uploading thumbnail, blob size:",
            blob.size,
          );
          await uploadThumbnail(accessTokenRef.current, projectId, blob);
          console.log("[canvas-editor] thumbnail uploaded OK");
        } catch (err) {
          console.warn(
            "[canvas-editor] thumbnail generation/upload failed:",
            err,
          );
        }
      }, THUMBNAIL_DEBOUNCE_MS);

      // --- 3. Selection change detection ---
      // Cheap string comparison avoids unnecessary downstream re-renders.
      const selectedIds = appState.selectedElementIds
        ? Object.keys(appState.selectedElementIds)
            .filter((id) => appState.selectedElementIds[id])
            .sort()
            .join(",")
        : "";

      if (selectedIds !== prevSelectedIdsRef.current) {
        prevSelectedIdsRef.current = selectedIds;
        if (onSelectionChangeRef.current) {
          if (!selectedIds) {
            onSelectionChangeRef.current([]);
          } else {
            const idSet = new Set(selectedIds.split(","));
            const selFiles: BinaryFiles = excalidrawApi?.getFiles() ?? {};
            const selected: CanvasSelectedElement[] = elements
              .filter((el) => idSet.has(el.id) && !el.isDeleted)
              .map((el) => {
                const base: CanvasSelectedElement = {
                  id: el.id,
                  type: el.type,
                  x: el.x ?? 0,
                  y: el.y ?? 0,
                  width: el.width ?? 0,
                  height: el.height ?? 0,
                };
                if (el.type === "text" && el.text) {
                  base.text = el.text;
                }
                if (el.type === "image" && el.fileId) {
                  base.fileId = el.fileId;
                  const file = selFiles[el.fileId];
                  if (file?.dataURL) {
                    base.dataUrl = file.dataURL;
                  }
                  // Prefer storage URL over base64 dataUrl for message attachments.
                  // Sources: 1) element customData (model-generated images)
                  //          2) initial canvas content files (server-resolved URLs)
                  const sUrl =
                    el.customData?.storageUrl ??
                    initialFilesRef.current[el.fileId]?.storageUrl;
                  if (typeof sUrl === "string" && sUrl) {
                    base.storageUrl = sUrl;
                  }
                }
                return base;
              });
            onSelectionChangeRef.current(selected);
          }
        }
      }
    },
    [canvasId, projectId, excalidrawApi],
  );

  // Register screenshot RPC handler so the server can request canvas captures
  useEffect(() => {
    if (!ws || !excalidrawApi) return;

    const cleanup = ws.registerRPC("canvas.screenshot", async (params) => {
      const {
        mode,
        region,
        max_dimension = 1024,
      } = params as {
        mode: string;
        region?: { x: number; y: number; width: number; height: number };
        max_dimension?: number;
      };

      const allElements = excalidrawApi
        .getSceneElements()
        .filter((e) => !e.isDeleted);
      const appState = excalidrawApi.getAppState();
      const files = excalidrawApi.getFiles();

      let elements = allElements;

      if (mode === "region" && region) {
        elements = allElements.filter((el) => {
          const ex = el.x;
          const ey = el.y;
          const ew = el.width;
          const eh = el.height;
          return !(
            ex + ew < region.x ||
            ex > region.x + region.width ||
            ey + eh < region.y ||
            ey > region.y + region.height
          );
        });
      } else if (mode === "viewport") {
        const zoom = appState.zoom?.value ?? 1;
        const sx = -appState.scrollX;
        const sy = -appState.scrollY;
        const vw = appState.width / zoom;
        const vh = appState.height / zoom;
        elements = allElements.filter((el) => {
          const ex = el.x;
          const ey = el.y;
          const ew = el.width;
          const eh = el.height;
          return !(
            ex + ew < sx ||
            ex > sx + vw ||
            ey + eh < sy ||
            ey > sy + vh
          );
        });
      }

      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements,
        appState: { ...appState, exportBackground: true },
        files,
        maxWidthOrHeight: max_dimension,
        mimeType: "image/png",
      });

      // Convert blob to base64 data URL directly (no upload needed --
      // the image is passed inline to the model for visual understanding)
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () =>
          reject(new Error("Failed to convert screenshot to data URL"));
        reader.readAsDataURL(blob);
      });

      const bmp = await createImageBitmap(blob);
      const width = bmp.width;
      const height = bmp.height;
      bmp.close();

      return { url: dataUrl, width, height };
    });

    return cleanup;
  }, [ws, excalidrawApi]);

  // Build a full save payload from current Excalidraw state.
  // Used by both beforeunload and unmount to flush pending changes.
  const buildSavePayload = useCallback(() => {
    if (!excalidrawApi) return null;
    // Never flush before hydration — Excalidraw may not have loaded elements yet
    if (!hydratedRef.current) return null;
    try {
      const sceneElements = excalidrawApi.getSceneElements();
      const rawFiles = excalidrawApi.getFiles();
      const appState = excalidrawApi.getAppState();

      // 与防抖自动保存共用同一判定（canvas-save-guard），两条路径不再各写一份。
      const liveCount = sceneElements.filter((el) => !el.isDeleted).length;
      if (shouldRefuseEmptySave({ incomingCount: liveCount })) {
        console.warn("[canvas-editor] skipping save: 空场景不写库");
        return null;
      }
      const files: Record<string, Record<string, unknown>> = {};
      for (const [id, file] of Object.entries(rawFiles)) {
        files[id] = {
          id: file.id,
          dataURL: file.dataURL,
          mimeType: file.mimeType,
          created: file.created,
        };
      }
      return {
        elements: sceneElements.filter((el) => !el.isDeleted),
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridModeEnabled: appState.gridModeEnabled,
        },
        files,
      };
    } catch (err) {
      console.warn(
        "[canvas-editor] failed to build save payload on flush:",
        err,
      );
      return null;
    }
  }, [excalidrawApi]);

  /**
   * 立即保存（Ctrl/Cmd+S 与右键菜单「保存画布」共用）。
   *
   * 自动保存是防抖的（1.5s），手动保存要的是「按下去就落库」：先取消挂起的防抖任务，
   * 再从 Excalidraw 当前状态取一份完整 payload 写库。空场景依旧不写（见 canvas-save-guard），
   * 且**空场景不算失败**——提示语区分「已保存 / 画布为空无需保存 / 保存失败」。
   */
  const saveNow = useCallback(async (): Promise<SaveOutcome> => {
    if (!excalidrawApi || !hydratedRef.current) return "empty";
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const payload = buildSavePayloadRef.current();
    // 空场景无处可存（见 canvas-save-guard）——这是「没内容」，不是「失败」
    if (!payload) return "empty";
    try {
      await saveCanvas(accessTokenRef.current, canvasIdRef.current, payload);
      pendingSaveRef.current = null;
      return "saved";
    } catch (err) {
      console.error("[canvas-editor] 手动保存失败:", err);
      return "error";
    }
  }, [excalidrawApi]);

  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;

  /** 保存反馈：右下角短暂显示「已保存 / 画布为空无需保存 / 保存失败」。 */
  const [saveHint, setSaveHint] = useState<SaveOutcome | null>(null);

  /**
   * Ctrl/Cmd+S → 立即保存到服务端。
   *
   * **必须在捕获阶段截住并 stopImmediatePropagation**：Excalidraw 自己把原生 Ctrl+S 绑给了
   * `saveToActiveFile`（导出到文件），只在冒泡阶段 preventDefault 挡不住它——用户实测按
   * Ctrl+S 弹出的是「保存 .excalidraw 文件」对话框（文件名 `无标题-<时间戳>.excalidraw`），
   * 我们的服务端保存虽然也跑了，但用户看到的是那个对话框。捕获阶段在 window 上先拿到事件并
   * 阻断传播，Excalidraw 的处理器就再也收不到。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void saveNowRef.current().then((outcome) => setSaveHint(outcome));
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // 保存提示 2 秒后自动消失
  useEffect(() => {
    if (!saveHint) return;
    const t = window.setTimeout(() => setSaveHint(null), 2000);
    return () => window.clearTimeout(t);
  }, [saveHint]);

  /**
   * 右键菜单补一项「保存画布 Ctrl+S」。
   *
   * Excalidraw 0.18 的画布右键菜单没有保存（它天然没有「存到服务端」的概念），也没有
   * 自定义菜单项的口子（无 renderCustomContextMenu），故用 MutationObserver 在菜单挂载
   * 时把这一项追加进去——与本项目既有的「用 CSS 覆写菜单文案」是同一类做法：只补一项、
   * 点击后自己收起菜单；上游改版导致注入失败时，最坏情况只是这一项不出现。
   */
  useEffect(() => {
    const inject = () => {
      const menu = document.querySelector<HTMLElement>(".context-menu");
      if (!menu || menu.querySelector("[data-kfw-save]")) return;
      const item = document.createElement("li");
      item.className = "context-menu-item";
      item.setAttribute("data-kfw-save", "");
      item.setAttribute("data-testid", "kfwSave");
      item.innerHTML =
        '<div class="context-menu-item__label">保存画布</div>' +
        '<span class="context-menu-item__shortcut">Ctrl+S</span>';
      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void saveNowRef.current().then((outcome) => setSaveHint(outcome));
        // 自己收起菜单：向画布派发一次 pointerdown（走 Excalidraw 的「点击外部关闭」）
        document.querySelector("canvas")?.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      menu.appendChild(item);
    };
    const observer = new MutationObserver(inject);
    observer.observe(document.body, { childList: true, subtree: true });
    inject();
    return () => observer.disconnect();
  }, []);

  // Keep buildSavePayload accessible without stale closures
  const buildSavePayloadRef = useRef(buildSavePayload);
  buildSavePayloadRef.current = buildSavePayload;

  // Flush pending save on page close (beforeunload) and component unmount
  useEffect(() => {
    const flushBeforeUnload = () => {
      if (!pendingSaveRef.current) return;

      // Build the real payload since pendingSaveRef may hold a placeholder
      const payload = buildSavePayloadRef.current();
      if (!payload) return;

      // Use fetch with keepalive to ensure the request survives page teardown.
      // keepalive requests are limited to 64 KiB total in-flight per page; for
      // canvases with very large embedded files this may exceed the limit, but
      // it's the best-effort approach -- sendBeacon has the same constraint.
      const url = `${getServerBaseUrl()}/api/canvases/${canvasIdRef.current}`;
      try {
        serverFetch(url, {
          method: "PUT",
          headers: {
            ...bearerHeaders(accessTokenRef.current),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: payload }),
          keepalive: true,
        });
      } catch {
        // Best-effort -- nothing we can do if it fails during page teardown
      }
      pendingSaveRef.current = null;
    };

    window.addEventListener("beforeunload", flushBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);

      // Cancel pending debounce timers
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (thumbnailTimerRef.current) clearTimeout(thumbnailTimerRef.current);

      // Flush pending save on component unmount (e.g. SPA navigation)
      if (pendingSaveRef.current) {
        const payload = buildSavePayloadRef.current();
        if (payload) {
          saveCanvas(
            accessTokenRef.current,
            canvasIdRef.current,
            payload,
          ).catch(console.error);
        }
        pendingSaveRef.current = null;
      }
    };
  }, []);

  // Render custom embeddable content for video elements on canvas.
  // Excalidraw calls this for every embeddable element; we intercept video URLs
  // and render an inline player, falling back to default for everything else.
  const renderEmbeddable: NonNullable<ExcalidrawProps["renderEmbeddable"]> =
    useCallback((element, _appState) => {
      const link = element.link;
      if (typeof link === "string" && isVideoUrl(link)) {
        return (
          <VideoCanvasElement
            src={link}
            width={element.width ?? 640}
            height={element.height ?? 360}
          />
        );
      }
      // Return null to let Excalidraw handle non-video embeddables with default behavior
      return null;
    }, []);

  // Allow any URL as a valid embeddable so our video links are accepted
  const validateEmbeddable = useCallback(() => true, []);

  return (
    <ErrorBoundary
      onError={(err) => console.error("[canvas-editor] render crashed:", err)}
    >
      <div className="h-full w-full relative">
        {saveHint && (
          /* 提示放顶部居中（用户要求）：底部居中会被绘图工具条压住，角落又容易被忽略 */
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-1 text-xs text-foreground shadow-card"
          >
            {saveHint === "saved"
              ? "已保存"
              : saveHint === "empty"
                ? "画布为空，无需保存"
                : "保存失败，请重试"}
          </div>
        )}
        <Excalidraw
          // 原生 UI 语言：不指定则默认英文（右键菜单 / 缩放 / 帮助 等全英文）
          langCode="zh-CN"
          theme={resolvedTheme === "dark" ? "dark" : "light"}
          initialData={{
            // 服务端契约把画布内容存成不透明 JSON（Record<string, unknown>），
            // 进画布时才按 Excalidraw 场景类型收窄；形状由写端（本组件）保证。
            elements: initialContent.elements as unknown as NonNullable<
              ExcalidrawInitialDataState["elements"]
            >,
            appState: initialContent.appState as unknown as NonNullable<
              ExcalidrawInitialDataState["appState"]
            >,
            files: inlineFiles as unknown as NonNullable<
              ExcalidrawInitialDataState["files"]
            >,
          }}
          onChange={handleChange}
          excalidrawAPI={handleExcalidrawApi}
          renderCustomStats={(elements, appState) => (
            <CanvasStatsPanel
              elements={elements}
              appState={appState}
              excalidrawApi={excalidrawApi}
            />
          )}
          renderEmbeddable={renderEmbeddable}
          validateEmbeddable={validateEmbeddable}
        >
          {/* 画布内覆盖层：放在 Excalidraw 内部，使其右键菜单/弹层自然盖在它之上
              （此前是外部 z-20 兄弟节点，会压住菜单——用户反馈「像菜单透明」） */}
          {overlay}
        </Excalidraw>
      </div>
    </ErrorBoundary>
  );
}
