"use client";

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

export type CanvasLayersPanelProps = {
  excalidrawApi: ExcalidrawImperativeAPI | null;
  /** 面板是否可见：不可见时退订画布变更（隐藏的列表没必要跟着重算）。 */
  active: boolean;
};

/* -- Throttle utility -- */
/** Simple trailing-edge throttle. Ensures fn fires at most once per `ms`. */
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

/* -- Icon helpers -- */
const LockIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <rect
      x="3.5"
      y="7"
      width="9"
      height="6.5"
      rx="1.5"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <path
      d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

const EyeIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
    <path
      d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

/* -- Element helpers -- */
function elLabel(el: ExcalidrawElement): string {
  if (el.customData?.type === "image-generator") {
    return el.customData?.title?.slice(0, 20) || "Image Generator";
  }
  if (el.type === "text") return el.text?.slice(0, 20) || "Text";
  if (el.type === "image") {
    return el.customData?.title?.slice(0, 20) || "图像";
  }
  return el.type.charAt(0).toUpperCase() + el.type.slice(1);
}

function elThumbnailIcon(el: ExcalidrawElement): string {
  if (el.customData?.type === "image-generator") return "\u2728";
  if (el.type === "text") return "T";
  if (el.type === "image") return "";
  if (el.type === "rectangle") return "\u25AD";
  if (el.type === "ellipse") return "\u25EF";
  if (el.type === "diamond") return "\u25C7";
  if (el.type === "line") return "\u2500";
  if (el.type === "arrow") return "\u2192";
  return "\u25C6";
}

/* -- Thumbnail component -- */
function LayerThumbnail({
  el,
  files,
}: {
  el: ExcalidrawElement;
  files: BinaryFiles;
}) {
  const icon = elThumbnailIcon(el);

  // For image elements, try to show a small preview
  if (el.type === "image" && el.fileId) {
    const file = files[el.fileId];
    if (file?.dataURL) {
      return (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-muted overflow-hidden">
          {/* biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用 */}
          <img
            src={file.dataURL}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </div>
      );
    }
  }

  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-muted text-[11px] leading-none text-muted-foreground">
      {icon}
    </div>
  );
}

/* -- Layer row (memoized to prevent re-render when other rows' selection changes) -- */
const LayerRow = memo(function LayerRow({
  el,
  files,
  selected,
  onSelect,
}: {
  el: ExcalidrawElement;
  files: BinaryFiles;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const handleClick = useCallback(() => onSelect(el.id), [onSelect, el.id]);
  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onSelect(el.id);
    },
    [onSelect, el.id],
  );

  return (
    <div
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 44px" }}
    >
      {/*
        行本体是 div + role="button"，不是 <button>：行内还有「锁定 / 可见性」两个
        真按钮，<button> 套 <button> 是非法 DOM（Next.js 开发覆盖层会报
        "button cannot contain a nested button"）。键盘等价性用 Enter/Space 补回。
      */}
      {/* biome-ignore lint/a11y/useSemanticElements: 行内有「锁定 / 可见性」两个真按钮（见上方说明），<button> 套 <button> 非法 */}
      <div
        role="button"
        tabIndex={0}
        className={`group/layer flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
          selected ? "bg-muted" : "hover:bg-muted"
        }`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <LayerThumbnail el={el} files={files} />
        <span className="flex-1 truncate text-[11px] text-foreground min-w-0">
          {elLabel(el)}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="invisible flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover/layer:visible cursor-pointer outline-none focus-visible:visible focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            aria-label="锁定图层"
            onClick={(e) => e.stopPropagation()}
          >
            <LockIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="invisible flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground group-hover/layer:visible cursor-pointer outline-none focus-visible:visible focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            aria-label="切换图层可见性"
            onClick={(e) => e.stopPropagation()}
          >
            <EyeIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
});

/* ================================================================
   Main component
   ================================================================ */
export function CanvasLayersPanel({
  excalidrawApi,
  active,
}: CanvasLayersPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [elements, setElements] = useState<ExcalidrawElement[]>([]);
  const [files, setFiles] = useState<BinaryFiles>({});
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  /* -- Refresh elements on open + subscribe to changes -- */
  const refreshElements = useCallback(() => {
    if (!excalidrawApi) return;
    const all = excalidrawApi.getSceneElements();
    setElements(all.filter((el) => !el.isDeleted).reverse());
    setFiles(excalidrawApi.getFiles() ?? {});
    const state = excalidrawApi.getAppState();
    setSelectedIds(state.selectedElementIds ?? {});
  }, [excalidrawApi]);

  // Throttle refresh to avoid hammering React state on every drag frame.
  // 100ms gives smooth UI without excessive re-renders during drawing.
  useEffect(() => {
    if (!active || !excalidrawApi) return;
    // Initial refresh is immediate
    refreshElements();

    const throttledRefresh = throttle(refreshElements, 100);
    const unsubscribe = excalidrawApi.onChange(() => {
      throttledRefresh();
    });
    return () => {
      throttledRefresh.cancel();
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [active, excalidrawApi, refreshElements]);

  /* -- Select element on canvas -- */
  const selectElement = useCallback(
    (id: string) => {
      excalidrawApi?.updateScene({
        appState: { selectedElementIds: { [id]: true } },
      });
    },
    [excalidrawApi],
  );

  if (!active) return null;

  return (
    <div
      ref={panelRef}
      role="none"
      className="flex-1 overflow-y-auto px-1 py-1"
      style={{ contain: "layout style" }}
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {elements.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">
          画布为空
        </p>
      ) : (
        elements.map((el) => (
          <LayerRow
            key={el.id}
            el={el}
            files={files}
            selected={!!selectedIds[el.id]}
            onSelect={selectElement}
          />
        ))
      )}
    </div>
  );
}
