"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { createPortal } from "react-dom";

/* ── Preset color swatches for background picker ── */
const BG_PRESETS = [
  "transparent",
  "#000000",
  "#FFFFFF",
  "#d3f256",
  "#6C5CE7",
  "#00B894",
  "#FD79A8",
  "#0984E3",
] as const;

const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2] as const;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 30;
const ZOOM_STEP = 1.1;

/* ── Types ── */
interface CanvasViewControlsProps {
  // biome-ignore lint/suspicious/noExplicitAny: Excalidraw API has no public type definition
  excalidrawApi: any | null;
}

/* ── Inline SVG icons ── */
type IcoProps = {
  className?: string | undefined;
  children: React.ReactNode;
  vb?: string | undefined;
  fill?: string | undefined;
};
const Ico = ({
  className,
  children,
  vb = "0 0 16 16",
  fill = "none",
}: IcoProps) => (
  <svg viewBox={vb} fill={fill} className={className}>
    {children}
  </svg>
);
const MinusIcon = ({ className }: { className?: string }) => (
  <Ico className={className}>
    <path
      d="M3.5 8h9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </Ico>
);
const PlusIcon = ({ className }: { className?: string }) => (
  <Ico className={className}>
    <path
      d="M8 3.5v9M3.5 8h9"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </Ico>
);
const GridIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
  </svg>
);

const CloseIcon = ({ className }: { className?: string }) => (
  <Ico className={className}>
    <path
      d="M4.5 4.5l7 7M11.5 4.5l-7 7"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </Ico>
);

/* checkerboard pattern for "transparent" swatch */
const CheckerIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={className}>
    <rect width="8" height="8" fill="#ccc" />
    <rect x="8" y="8" width="8" height="8" fill="#ccc" />
    <rect x="8" width="8" height="8" fill="#fff" />
    <rect y="8" width="8" height="8" fill="#fff" />
  </svg>
);

/* checkerboard inline style for the transparent swatch button */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg,#ccc 25%,transparent 25%),linear-gradient(-45deg,#ccc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#ccc 75%),linear-gradient(-45deg,transparent 75%,#ccc 75%)",
  backgroundSize: "8px 8px",
  backgroundPosition: "0 0,0 4px,4px -4px,-4px 0px",
};

/* ── Hook: dismiss popover on Escape / click-outside ── */
function usePopoverDismiss(
  open: boolean,
  onClose: () => void,
  containerRef: React.RefObject<HTMLElement | null>,
  triggerRef: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t) || triggerRef.current?.contains(t))
        return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onClick, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onClick, true);
    };
  }, [open, onClose, containerRef, triggerRef]);
}

/* ── Portal popover positioned above its trigger ── */
function Popover({
  open,
  triggerRef,
  onClose,
  children,
  className: extraClass,
}: {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, onClose, containerRef, triggerRef);
  const [pos, setPos] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({
      position: "fixed",
      left: r.left,
      bottom: window.innerHeight - r.top + 8,
      opacity: 1,
      zIndex: 50,
    });
  }, [open, triggerRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={containerRef}
      style={pos}
      className={`rounded-lg bg-card border border-border shadow-float animate-in fade-in slide-in-from-bottom-2 duration-150 ${extraClass ?? "p-2"}`}
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ── Toolbar button ── */
const btnClass =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";

/* ── Element helpers for Search ── */
// biome-ignore lint/suspicious/noExplicitAny: Excalidraw element has no public type
type ExcalidrawEl = any;
const TYPE_ICONS: Record<string, string> = {
  text: "T",
  image: "🖼",
  rectangle: "▭",
  ellipse: "◯",
  diamond: "◇",
  line: "─",
  arrow: "→",
};
const elTypeIcon = (t: string) => TYPE_ICONS[t] ?? "◆";
const EL_TYPE_LABELS: Record<string, string> = {
  rectangle: "矩形",
  ellipse: "椭圆",
  diamond: "菱形",
  line: "直线",
  arrow: "箭头",
  text: "文字",
  frame: "框架",
  freedraw: "画笔",
  image: "图像",
  video: "视频",
};

function elLabel(el: ExcalidrawEl): string {
  if (el.type === "text") return (el.text as string)?.slice(0, 20) || "文字";
  return EL_TYPE_LABELS[el.type] ?? el.type;
}

function ElementRow({
  el,
  onSelect,
}: {
  el: ExcalidrawEl;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-md hover:bg-muted transition-colors text-foreground text-left"
      onClick={() => onSelect(el.id)}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-muted text-[10px] leading-none">
        {elTypeIcon(el.type)}
      </span>
      <span className="truncate">{elLabel(el)}</span>
    </button>
  );
}

/* ================================================================
   Main component
   ================================================================ */

/**
 * 画布底部工具条左侧的**视图控件组**（背景色 / 图层 / 生成文件 / 网格 / 缩放）。
 *
 * 它不再自带定位与外框：底部原本是两条并列的浮条（这条左簇 + 居中的绘图工具条），
 * 窄视口下互相遮挡，还得靠测量避让（抬高一行）来兜。现在两条合成一条，外框由
 * `CanvasToolMenu` 那一行提供，本组件只出控件本身，于是避让逻辑连同它的测量代码一起
 * 消失——那套代码存在的唯一理由就是「两条并列」。
 */
export function CanvasViewControls({
  excalidrawApi,
}: CanvasViewControlsProps) {
  /* ── Zoom state ── */
  const [zoom, setZoom] = useState(1);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const [gridOn, setGridOn] = useState(false);
  const zoomBtnRef = useRef<HTMLButtonElement>(null);

  /**
   * 与底部居中的绘图工具条避让。
   *
   * 画布区被侧栏/助手面板挤压后会变窄（实测 1280 视口下只剩 624px），而工具条
   * 是居中的、自身就有 ~400px：从左簇右缘到画布右边的空档放不下它，两者就会重叠
   * ——工具条 z-30 压在左簇之上，`网格/缩小/100%/放大` 被盖住点不到（elementFromPoint
   * 命中的是「拖拽画布/选择/椭圆」）。
   *
   * 取舍：**抬高左簇、不动工具条**。工具条是主 affordance，位置应稳定；左簇是次级
   * 控件，让位代价最小。实测行不通的替代方案：只挪 left 或只调 z-index——前者在
   * 「空档 < 工具条宽度」时无解，后者只是把点不到的控件换一批。
   *
   * **后续**：两条已合成一条（见组件注释），这段避让随「两条并列」这个前提一起作废。
   */

  /* ── Background color state ── */
  const [bgColor, setBgColor] = useState("#FFFFFF");
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  const [hexInput, setHexInput] = useState("FFFFFF");
  const bgBtnRef = useRef<HTMLButtonElement>(null);

  /* ── Files panel is controlled by parent ── */

  /* ── Sync zoom from excalidraw ── */
  useEffect(() => {
    if (!excalidrawApi) return;
    const state = excalidrawApi.getAppState();
    setZoom(state.zoom.value);
    const initBg = state.viewBackgroundColor ?? "#FFFFFF";
    setBgColor(initBg);
    setHexInput(initBg.replace(/^#/, "").toUpperCase());

    setGridOn(Boolean(state.gridSize));
    const unsubscribe = excalidrawApi.onChange(() => {
      const s = excalidrawApi.getAppState();
      setZoom(s.zoom.value);
      setBgColor(s.viewBackgroundColor ?? "#FFFFFF");
      setGridOn(Boolean(s.gridSize));
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [excalidrawApi]);

  /* ── 网格开关（Excalidraw 原生的「Toggle grid」缺中文键，改由底部栏自绘） ── */
  const handleToggleGrid = useCallback(() => {
    const current = excalidrawApi?.getAppState().gridSize ?? null;
    excalidrawApi?.updateScene({ appState: { gridSize: current ? null : 20 } });
  }, [excalidrawApi]);

  /* ── Zoom helpers ── */
  const applyZoom = useCallback(
    (value: number) => {
      excalidrawApi?.updateScene({ appState: { zoom: { value } } });
    },
    [excalidrawApi],
  );

  const handleZoomIn = useCallback(() => {
    if (!excalidrawApi) return;
    applyZoom(
      Math.min(excalidrawApi.getAppState().zoom.value * ZOOM_STEP, ZOOM_MAX),
    );
  }, [excalidrawApi, applyZoom]);

  const handleZoomOut = useCallback(() => {
    if (!excalidrawApi) return;
    applyZoom(
      Math.max(excalidrawApi.getAppState().zoom.value / ZOOM_STEP, ZOOM_MIN),
    );
  }, [excalidrawApi, applyZoom]);

  const handleZoomTo = useCallback(
    (v: number) => {
      applyZoom(v);
      setZoomMenuOpen(false);
    },
    [applyZoom],
  );
  const handleFitAll = useCallback(() => {
    excalidrawApi?.scrollToContent();
    setZoomMenuOpen(false);
  }, [excalidrawApi]);

  /* ── Background color helpers ── */
  const applyBgColor = useCallback(
    (hex: string) => {
      if (!excalidrawApi) return;
      excalidrawApi.updateScene({ appState: { viewBackgroundColor: hex } });
      setBgColor(hex);
      if (hex !== "transparent")
        setHexInput(hex.replace(/^#/, "").toUpperCase());
    },
    [excalidrawApi],
  );

  const handleHexInputSubmit = useCallback(() => {
    const raw = hexInput.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(raw)) applyBgColor(`#${raw}`);
  }, [hexInput, applyBgColor]);

  /* ── (files list is now a separate panel component) ── */

  /* ── Toggle helpers (close sibling popovers) ── */
  const closeAllPopovers = useCallback(() => {
    setZoomMenuOpen(false);
    setBgPickerOpen(false);
  }, []);
  const toggleZoomMenu = useCallback(() => {
    const next = !zoomMenuOpen;
    closeAllPopovers();
    if (next) setZoomMenuOpen(true);
  }, [zoomMenuOpen, closeAllPopovers]);
  const toggleBgPicker = useCallback(() => {
    const next = !bgPickerOpen;
    closeAllPopovers();
    if (next) setBgPickerOpen(true);
  }, [bgPickerOpen, closeAllPopovers]);

  return (
    <div
      className="flex items-center gap-0.5"
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-0.5">
        {/* ── Background color button ── */}
        <button
          ref={bgBtnRef}
          type="button"
          className={btnClass}
          onClick={toggleBgPicker}
          aria-label="背景色"
        >
          {bgColor === "transparent" ? (
            <CheckerIcon className="h-4 w-4 rounded-full" />
          ) : (
            <span
              className="block h-4 w-4 rounded-full border border-border"
              style={{ backgroundColor: bgColor }}
            />
          )}
        </button>

        {/* ── Grid toggle ── */}
        <button
          type="button"
          className={`${btnClass} ${gridOn ? "bg-muted text-foreground" : ""}`}
          onClick={handleToggleGrid}
          aria-label="网格"
          aria-pressed={gridOn}
          title={gridOn ? "关闭网格" : "显示网格"}
        >
          <GridIcon className="h-4 w-4" />
        </button>

        {/* ── Divider ── */}
        <span className="mx-1 h-3 w-px bg-border" />

        {/* ── Zoom controls ── */}
        <button
          type="button"
          className={btnClass}
          onClick={handleZoomOut}
          aria-label="缩小"
        >
          <MinusIcon className="h-3.5 w-3.5" />
        </button>
        <button
          ref={zoomBtnRef}
          type="button"
          className="min-w-[40px] text-center text-xs text-muted-foreground select-none cursor-pointer hover:text-foreground transition-colors"
          onClick={toggleZoomMenu}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          className={btnClass}
          onClick={handleZoomIn}
          aria-label="放大"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Zoom preset popover ── */}
      <Popover
        open={zoomMenuOpen}
        triggerRef={zoomBtnRef}
        onClose={() => setZoomMenuOpen(false)}
      >
        <div className="flex flex-col gap-0.5 min-w-[100px]">
          {ZOOM_PRESETS.map((v) => (
            <button
              key={v}
              type="button"
              className="px-3 py-1.5 text-xs text-left rounded-md hover:bg-muted transition-colors text-foreground"
              onClick={() => handleZoomTo(v)}
            >
              {Math.round(v * 100)}%
            </button>
          ))}
          <div className="h-px bg-border my-0.5" />
          <button
            type="button"
            className="px-3 py-1.5 text-xs text-left rounded-md hover:bg-muted transition-colors text-foreground"
            onClick={handleFitAll}
          >
            全览
          </button>
        </div>
      </Popover>

      {/* ── Background color picker popover ── */}
      <Popover
        open={bgPickerOpen}
        triggerRef={bgBtnRef}
        onClose={() => setBgPickerOpen(false)}
        className="w-[260px] rounded-2xl p-3"
      >
        <div className="flex flex-col gap-3">
          {/* Title bar */}
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">
              画布背景色
            </span>
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setBgPickerOpen(false)}
              aria-label="关闭取色器"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Separator */}
          <div className="h-px bg-border -mx-3" />
          {/* Color wheel picker */}
          <HexColorPicker
            color={bgColor === "transparent" ? "#FFFFFF" : bgColor}
            onChange={applyBgColor}
            style={{ width: "100%", height: 160 }}
          />
          {/* Preset swatches */}
          <div className="flex flex-wrap items-center gap-2">
            {BG_PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`h-6 w-6 shrink-0 rounded-full border hover:scale-110 transition-transform ${bgColor === hex ? "border-foreground ring-1 ring-foreground ring-offset-1 ring-offset-card" : "border-border"}`}
                style={
                  hex === "transparent"
                    ? CHECKER_STYLE
                    : { backgroundColor: hex }
                }
                onClick={() => applyBgColor(hex)}
                aria-label={`Set background to ${hex}`}
              />
            ))}
          </div>
          {/* Hex input row */}
          <div className="flex items-center gap-1.5">
            <div className="flex flex-1 items-center rounded-lg border border-border bg-muted overflow-hidden">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center text-xs text-muted-foreground">
                #
              </span>
              <input
                type="text"
                value={hexInput}
                onChange={(e) => {
                  const v = e.target.value
                    .replace(/[^0-9a-fA-F]/g, "")
                    .slice(0, 6);
                  setHexInput(v.toUpperCase());
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") handleHexInputSubmit();
                }}
                onBlur={handleHexInputSubmit}
                maxLength={6}
                className="h-7 flex-1 border-none bg-transparent text-xs text-foreground outline-none"
              />
            </div>
            <div className="flex items-center rounded-lg border border-border bg-muted overflow-hidden">
              <input
                type="text"
                value="100"
                readOnly
                className="h-7 w-8 border-none bg-transparent text-center text-xs text-foreground outline-none"
              />
              <span className="flex h-7 w-6 shrink-0 items-center justify-center text-xs text-muted-foreground pr-1">
                %
              </span>
            </div>
          </div>
        </div>
      </Popover>
    </div>
  );
}
