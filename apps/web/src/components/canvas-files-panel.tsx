"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw API/element has no public type
type ExcalidrawEl = any;

export type CanvasFilesPanelProps = {
  // biome-ignore lint/suspicious/noExplicitAny: Excalidraw API has no public type definition
  excalidrawApi: any;
  /** 面板是否可见：不可见时退订画布变更（隐藏的列表没必要跟着重算）。 */
  active: boolean;
};

/* -- Throttle utility -- */
function throttle<T extends (...args: any[]) => void>(
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
    viewBox="0 0 24 24"
    fill="currentColor"
    fillOpacity={0.9}
    className={className}
  >
    <path d="M3 17.25v-2.5a.75.75 0 0 1 1.5 0v2.5a2.25 2.25 0 0 0 2.25 2.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-2.5a.75.75 0 0 1 1.5 0v2.5A3.75 3.75 0 0 1 17.25 21H6.75A3.75 3.75 0 0 1 3 17.25m8.25-13.5a.75.75 0 0 1 1.5 0v9.44l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22z" />
  </svg>
);

type ImageFile = { id: string; name: string; dataURL: string };

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
  excalidrawApi,
  active,
}: CanvasFilesPanelProps) {
  const [imageFiles, setImageFiles] = useState<ImageFile[]>([]);

  const refreshFiles = useCallback(() => {
    if (!excalidrawApi) return;
    const allElements = excalidrawApi.getSceneElements() as ExcalidrawEl[];
    const files: Record<string, any> = excalidrawApi.getFiles() ?? {};
    const images: ImageFile[] = [];
    let idx = 0;
    for (const el of allElements) {
      if (el.isDeleted || el.type !== "image" || !el.fileId) continue;
      // Only show AI-generated images, not user-uploaded ones
      if (el.customData?.source !== "generated" && !el.customData?.title)
        continue;
      idx++;
      const file = files[el.fileId];
      const title =
        el.customData?.title || el.customData?.label || `Image ${idx}`;
      images.push({ id: el.id, name: title, dataURL: file?.dataURL ?? "" });
    }
    setImageFiles(images.reverse());
  }, [excalidrawApi]);

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

  const handleDownload = useCallback((file: ImageFile) => {
    if (!file.dataURL) return;
    const a = document.createElement("a");
    a.href = file.dataURL;
    a.download = `${file.name}.png`;
    a.click();
  }, []);

  if (!active) return null;

  return (
    <div
      className="flex-1 overflow-y-auto px-2 pb-4"
      style={{ contain: "layout style" }}
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
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
