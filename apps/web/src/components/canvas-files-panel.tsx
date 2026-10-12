"use client";

import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { memo, useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/toast";
import { triggerDownload } from "@/lib/download";
import {
  ApiApplicationError,
  inspectProjectFile,
  moveCanvasAsset,
  relinkProjectFile,
} from "@/lib/server-api";

export type CanvasFilesPanelProps = {
  canvasId: string;
  prepareCanvasAssetOperation: () => Promise<string | null>;
  excalidrawApi: ExcalidrawImperativeAPI | null;
  /** 面板是否可见：不可见时退订画布变更（隐藏的列表没必要跟着重算）。 */
  active: boolean;
  accessToken: string | null;
  onCanvasSync: () => Promise<void>;
  onRestoreAssets: () => Promise<void>;
};

/* -- Throttle utility -- */
function throttle<T extends (...args: never[]) => void>(
  fn: T,
  ms: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  const throttled = ((...args: Parameters<T>) => {
    lastArgs = args;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) fn(...lastArgs);
      lastArgs = null;
    }, ms);
  }) as T & { cancel: () => void };
  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };
  return throttled;
}

const DownloadIcon = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="currentColor"
    fillOpacity={0.9}
    className={className}
  >
    <path d="M3 17.25v-2.5a.75.75 0 0 1 1.5 0v2.5a2.25 2.25 0 0 0 2.25 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-2.5a.75.75 0 0 1 1.5 0v2.5A3.75 3.75 0 0 1 17.25 21H6.75A3.75 3.75 0 0 1 3 17.25m8.25-13.5a.75.75 0 0 1 1.5 0v9.44l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22z" />
  </svg>
);

type ImageFile = { id: string; name: string; dataURL: string };
type RegisteredAsset = {
  assetId: string;
  path: string;
  version: string;
  status: "checking" | "available" | "missing" | "moved" | "error";
  assetError?: string;
  serverPath?: string;
  error?: string;
};

/** Memoized file row to prevent re-renders when other files change */
const FileRow = memo(function FileRow({
  file,
  onDownload,
}: {
  file: ImageFile;
  onDownload: (file: ImageFile) => void;
}) {
  const handleDownload = useCallback(
    () => onDownload(file),
    [onDownload, file],
  );

  return (
    <div
      className="group flex items-center gap-3 rounded-lg px-2 py-1 hover:bg-muted transition-colors"
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 56px" }}
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg shadow-subtle">
        {file.dataURL ? (
          // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
          <img
            alt={file.name}
            className="h-full w-full object-cover"
            draggable={false}
            src={file.dataURL}
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground text-xs">
            N/A
          </div>
        )}
      </div>
      <div className="flex-1 overflow-hidden text-sm leading-[22px] text-foreground min-w-0">
        <div className="overflow-hidden text-ellipsis whitespace-nowrap">
          {file.name}
        </div>
      </div>
      <button
        type="button"
        onClick={handleDownload}
        className="flex h-4 w-4 shrink-0 items-center justify-center text-foreground hover:text-muted-foreground transition-colors"
        title="下载"
        aria-label={`Download ${file.name}`}
      >
        <DownloadIcon className="h-4 w-4" />
      </button>
    </div>
  );
});

export function CanvasFilesPanel({
  canvasId,
  prepareCanvasAssetOperation,
  excalidrawApi,
  active,
  accessToken,
  onCanvasSync,
  onRestoreAssets,
}: CanvasFilesPanelProps) {
  const { error: toastError } = useToast();
  const [imageFiles, setImageFiles] = useState<ImageFile[]>([]);
  const [assets, setAssets] = useState<RegisteredAsset[]>([]);
  const [targetPaths, setTargetPaths] = useState<Record<string, string>>({});
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [restoringAssets, setRestoringAssets] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const refreshFiles = useCallback(() => {
    if (!excalidrawApi) return;
    const allElements = excalidrawApi.getSceneElements();
    const files: BinaryFiles = excalidrawApi.getFiles() ?? {};
    const images: ImageFile[] = [];
    const registered: RegisteredAsset[] = [];
    const seen = new Set<string>();
    let idx = 0;
    for (const el of allElements) {
      if (el.isDeleted || el.type !== "image" || !el.fileId) continue;
      const file = files[el.fileId];
      const metadata = file as
        | (typeof file & {
            assetId?: string;
            relativePath?: string;
            version?: string;
            assetError?: string;
          })
        | undefined;
      if (
        metadata?.assetId &&
        metadata.relativePath &&
        metadata.version &&
        !seen.has(metadata.assetId)
      ) {
        seen.add(metadata.assetId);
        registered.push({
          assetId: metadata.assetId,
          path: metadata.relativePath,
          version: metadata.version,
          status: "checking",
          ...(metadata.assetError ? { assetError: metadata.assetError } : {}),
        });
      }
      // Only show AI-generated images, not user-uploaded ones
      if (el.customData?.source !== "generated" && !el.customData?.title)
        continue;
      idx++;
      const title =
        el.customData?.title || el.customData?.label || `Image ${idx}`;
      images.push({ id: el.id, name: title, dataURL: file?.dataURL ?? "" });
    }
    for (const el of allElements) {
      const custom = el.customData as
        | {
            assetId?: string;
            relativePath?: string;
            version?: string;
            assetError?: string;
          }
        | null
        | undefined;
      if (
        el.isDeleted ||
        !custom?.assetId ||
        !custom.relativePath ||
        !custom.version ||
        seen.has(custom.assetId)
      )
        continue;
      seen.add(custom.assetId);
      registered.push({
        assetId: custom.assetId,
        path: custom.relativePath,
        version: custom.version,
        status: "checking",
        ...(custom.assetError ? { assetError: custom.assetError } : {}),
      });
    }
    setImageFiles(images.reverse());
    setAssets(registered);
  }, [excalidrawApi]);

  const assetRefs = assets.map(({ assetId, path, version, assetError }) => ({
    assetId,
    path,
    version,
    ...(assetError ? { assetError } : {}),
  }));
  const assetRefsKey = JSON.stringify(assetRefs);
  useEffect(() => {
    const refs = JSON.parse(assetRefsKey) as typeof assetRefs;
    if (!active || refs.length === 0) return;
    let cancelled = false;
    Promise.all(
      refs.map(async (asset) => {
        try {
          const location = await inspectProjectFile(accessToken, asset.assetId);
          const changed =
            location.relativePath !== asset.path ||
            location.version !== asset.version;
          const available = {
            ...asset,
            status:
              changed || asset.assetError
                ? ("moved" as const)
                : ("available" as const),
            ...(changed ? { serverPath: location.relativePath } : {}),
          };
          return available;
        } catch (error) {
          if (
            error instanceof ApiApplicationError &&
            ["file_missing", "not_found"].includes(error.code)
          ) {
            const missing = { ...asset, status: "missing" as const };
            return missing;
          }
          return {
            ...asset,
            status: "error" as const,
            error: error instanceof Error ? error.message : "素材状态查询失败",
          };
        }
      }),
    ).then((results) => {
      if (!cancelled) setAssets(results);
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, active, assetRefsKey]);

  // Throttle refresh to avoid excessive re-renders during canvas operations
  useEffect(() => {
    if (!active || !excalidrawApi) return;
    refreshFiles();
    const throttledRefresh = throttle(refreshFiles, 200);
    const unsubscribe = excalidrawApi.onChange(() => throttledRefresh());
    return () => {
      throttledRefresh.cancel();
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [active, excalidrawApi, refreshFiles]);

  const handleDownload = useCallback(async (file: ImageFile) => {
    if (!file.dataURL) return;
    // dataURL → blob：统一走 triggerDownload（桌面形态落系统下载目录 + 定位）
    const blob = await (await fetch(file.dataURL)).blob();
    await triggerDownload(`${file.name}.png`, blob);
  }, []);

  const handleRestoreAssets = useCallback(async () => {
    setRestoringAssets(true);
    setRestoreError(null);
    try {
      await onRestoreAssets();
    } catch (error) {
      setRestoreError(
        error instanceof Error ? error.message : "素材索引恢复失败。",
      );
    } finally {
      setRestoringAssets(false);
    }
  }, [onRestoreAssets]);

  const mutateAsset = useCallback(
    async (asset: (typeof assets)[number], relink: boolean) => {
      const relativePath = targetPaths[asset.assetId]?.trim();
      if (!relativePath) return;
      setBusyAsset(asset.assetId);
      try {
        const request = {
          relativePath,
          expectedRelativePath: asset.path,
          expectedVersion: asset.version,
        };
        if (relink)
          await relinkProjectFile(accessToken, asset.assetId, {
            ...request,
            fileVersion: asset.version,
          });
        else {
          const expectedRevision = await prepareCanvasAssetOperation();
          if (!expectedRevision) throw new Error("画布保存失败，素材未移动。");
          await moveCanvasAsset(accessToken, canvasId, asset.assetId, {
            ...request,
            expectedRevision,
          });
        }
        await onCanvasSync();
      } catch (err) {
        toastError(err instanceof Error ? err.message : "素材操作失败");
      } finally {
        setBusyAsset(null);
      }
    },
    [
      accessToken,
      canvasId,
      onCanvasSync,
      prepareCanvasAssetOperation,
      targetPaths,
      toastError,
    ],
  );

  if (!active) return null;

  return (
    <div
      role="none"
      className="flex-1 overflow-y-auto px-2 pb-4"
      style={{ contain: "layout style" }}
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {assets.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 border-b border-border px-2 pb-3">
          <div className="text-xs font-medium text-muted-foreground">
            已登记素材
          </div>
          {assets.some(
            (asset) => asset.status === "moved" || asset.assetError,
          ) ? (
            <div className="rounded-md border border-border p-2 text-xs">
              <span>素材索引需要恢复</span>
              <button
                type="button"
                disabled={restoringAssets}
                onClick={() => void handleRestoreAssets()}
                className="ml-2 rounded border border-border px-2 py-1"
              >
                恢复素材索引
              </button>
              {restoreError ? (
                <div role="alert" className="mt-1 text-destructive">
                  {restoreError}
                </div>
              ) : null}
            </div>
          ) : null}
          {assets.map((asset) => (
            <div
              key={asset.assetId}
              className="flex flex-col gap-1 rounded-md bg-muted/40 p-2 text-xs"
            >
              <div className="truncate" title={asset.path}>
                {asset.path}
                {asset.serverPath ? ` → ${asset.serverPath}` : ""}
                {asset.assetError ? ` · ${asset.assetError}` : ""}
                {asset.status === "missing"
                  ? " · 文件缺失"
                  : asset.status === "checking"
                    ? " · 检查中"
                    : ""}
              </div>
              {asset.error && (
                <div role="alert" className="text-destructive">
                  {asset.error}
                </div>
              )}
              <input
                aria-label={`素材目标路径 ${asset.assetId}`}
                className="h-7 rounded border border-border bg-background px-2"
                value={targetPaths[asset.assetId] ?? ""}
                placeholder="目标相对路径"
                onChange={(event) =>
                  setTargetPaths((paths) => ({
                    ...paths,
                    [asset.assetId]: event.target.value,
                  }))
                }
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!!busyAsset || asset.status !== "available"}
                  onClick={() => void mutateAsset(asset, false)}
                >
                  移动
                </button>
                <button
                  type="button"
                  disabled={!!busyAsset || asset.status !== "missing"}
                  onClick={() => void mutateAsset(asset, true)}
                >
                  重新关联
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {imageFiles.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-muted-foreground">
          暂无生成文件
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {imageFiles.map((file) => (
            <FileRow key={file.id} file={file} onDownload={handleDownload} />
          ))}
          <p className="py-2 text-center text-sm text-muted-foreground">
            到底了
          </p>
        </div>
      )}
    </div>
  );
}
