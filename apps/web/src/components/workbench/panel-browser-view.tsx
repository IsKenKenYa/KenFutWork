"use client";

import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  Globe,
  Monitor,
  MousePointerSquareDashed,
  RotateCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * 右栏浏览器（R3-1 / R3-4 的可用形态）。工具栏按参考图的浏览器面板排：
 * **第一行**是 后退 / 前进 / 刷新 + 地址栏 + 元素拾取 + ⋯ 菜单；
 * **第二行**是视口预设（`1280 × 720` 这类尺寸）与缩放预设——用户口径：
 * 「添加一些预设，预设不要做在地址栏右边」。
 *
 * 三条如实写明的边界：
 * - 后退/前进走**面板内历史栈**（跨源 iframe 读不到页面自己的 history）；
 * - 视口预设与缩放是**真的**（iframe 按预设尺寸排版、再按比例缩放到面板里），
 *   不是拿宽度假装；
 * - 「选择网页元素加入聊天」需要浏览器调试接口（CDP / 扩展），内嵌 iframe 拿不到跨源 DOM，
 *   所以按钮**禁用**并写明原因——不做假开关。
 */
export function BrowserPane({
  url,
  draft,
  reloadToken,
  canBack,
  canForward,
  onDraftChange,
  onNavigate,
  onBack,
  onForward,
  onReload,
}: {
  url: string;
  draft: string;
  reloadToken: number;
  canBack: boolean;
  canForward: boolean;
  onDraftChange: (value: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}) {
  const normalized = normalizeUrl(draft);
  const [viewportPreset, setViewportPreset] = useState<ViewportPresetId>("fit");
  const [zoom, setZoom] = useState<ZoomPresetId>("fit");
  /** 面板里这块预览区有多大（「适应面板」时的视口尺寸 = 它）。 */
  const frameRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [paneHeight, setPaneHeight] = useState(0);
  useEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      setPaneWidth(el.clientWidth);
      setPaneHeight(el.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [url]);

  const sizePreset = VIEWPORT_PRESETS.find((p) => p.id === viewportPreset)!;
  const viewportWidth = sizePreset.width ?? paneWidth;
  const viewportHeight = sizePreset.height ?? paneHeight;
  const fitScale =
    viewportWidth > 0 && viewportHeight > 0
      ? Math.min(1, paneWidth / viewportWidth, paneHeight / viewportHeight)
      : 1;
  const zoomPreset = ZOOM_PRESETS.find((p) => p.id === zoom)!;
  const scale = zoomPreset.scale ?? fitScale;

  const navButtonClass =
    "shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 第一行：导航 + 地址栏 + 元素拾取 + ⋯（不放预设——预设在同一工具栏的第二行） */}
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized) onNavigate(normalized);
        }}
      >
        <button
          type="button"
          aria-label="后退"
          disabled={!canBack}
          title="后退（本面板打开过的上一个地址）"
          onClick={onBack}
          className={navButtonClass}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          disabled={!canForward}
          title="前进（本面板打开过的下一个地址）"
          onClick={onForward}
          className={navButtonClass}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="刷新"
          disabled={!url}
          title="重新加载当前页面"
          onClick={onReload}
          className={navButtonClass}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <Globe className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label="地址"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            // 工具栏里没有「打开」按钮（与参考图一致）：回车即打开。
            // 不依赖表单的隐式提交——那要求表单里只有一个输入框，加个控件就会失效。
            if (event.key === "Enter") {
              event.preventDefault();
              if (normalized) onNavigate(normalized);
            }
          }}
          placeholder="输入网址，回车打开"
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          aria-label="选择网页元素加入聊天"
          disabled
          title="需要浏览器调试接口（CDP / 扩展）才能读到跨源页面的 DOM，内嵌 iframe 做不到——未实现能力，不做假开关"
          className="shrink-0 rounded-md p-1 text-muted-foreground opacity-40"
        >
          <MousePointerSquareDashed className="h-3.5 w-3.5" />
        </button>
        <Select
          aria-label="浏览器菜单"
          value=""
          onValueChange={(next) => {
            if (next === "open-system" && url) {
              window.open(url, "_blank", "noopener");
            }
            if (next === "copy" && url) {
              void navigator.clipboard?.writeText(url);
            }
          }}
          items={[
            { value: "open-system", label: "在系统浏览器打开" },
            { value: "copy", label: "复制地址" },
          ]}
        >
          <SelectTrigger
            className="shrink-0 gap-0 border-transparent px-1.5 py-1"
            aria-label="浏览器菜单"
            hideChevron
            title="更多（在系统浏览器打开 / 复制地址）"
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </SelectTrigger>
          <SelectContent className="min-w-40">
            <SelectItem value="open-system">在系统浏览器打开</SelectItem>
            <SelectItem value="copy">复制地址</SelectItem>
          </SelectContent>
        </Select>
      </form>

      {/* 第二行：视口预设 + 缩放预设（用户口径：预设不做在地址栏右边）。
          **都是真的**——iframe 按预设尺寸排版，再按比例缩放到面板里 */}
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2 py-1 text-[11px]">
        <span className="font-mono text-muted-foreground">
          {viewportWidth > 0 ? `${viewportWidth} × ${viewportHeight}` : "—"}
        </span>
        {sizePreset.width !== null && scale !== 1 ? (
          <span className="text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
        ) : null}
        <Select
          aria-label="视口预设"
          value={viewportPreset}
          onValueChange={(next) => {
            if (typeof next === "string") setViewportPreset(next as ViewportPresetId);
          }}
          items={VIEWPORT_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
          }))}
        >
          <SelectTrigger
            className="ml-auto shrink-0 gap-1 border-transparent bg-transparent px-1.5 py-0.5 text-[11px]"
            aria-label="视口预设"
            title="视口预设（页面按这个尺寸排版）"
          >
            <Monitor className="h-3.5 w-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-32">
            {VIEWPORT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          aria-label="预览缩放"
          value={zoom}
          onValueChange={(next) => {
            if (typeof next === "string") setZoom(next as ZoomPresetId);
          }}
          items={ZOOM_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.label,
          }))}
        >
          <SelectTrigger
            className="shrink-0 gap-1 border-transparent bg-transparent px-1.5 py-0.5 text-[11px]"
            aria-label="预览缩放"
            title="预览缩放（只影响这个面板里的显示）"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-28">
            {ZOOM_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {url ? (
        <div
          ref={frameRef}
          className="relative min-h-0 flex-1 overflow-auto rounded-xl border bg-background"
        >
          <iframe
            key={`${url}#${reloadToken}`}
            src={url}
            title={`右栏浏览器：${url}`}
            style={{
              width: viewportWidth > 0 ? `${viewportWidth}px` : "100%",
              height: viewportHeight > 0 ? `${viewportHeight}px` : "100%",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
            className="absolute top-0 left-0"
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          还没有打开页面。对话里点链接会自动在这里打开，也可以在地址栏输入。
        </p>
      )}
      <p className="text-[10px] text-muted-foreground">
        内嵌页面能否显示取决于目标站点是否允许被嵌入；被拒绝时会是一片空白，用「在系统浏览器
        打开」兜底。后退 / 前进记的是本面板打开过的地址（跨源页面自己的历史读不到）。
      </p>
    </div>
  );
}

/** 视口预设（参考图：`1280 × 720` 这类设备尺寸；`适应面板` = 跟面板一样大）。 */
const VIEWPORT_PRESETS = [
  { id: "fit", label: "适应面板", width: null, height: null },
  { id: "laptop", label: "1280 × 720", width: 1280, height: 720 },
  { id: "tablet", label: "1024 × 768", width: 1024, height: 768 },
  { id: "phone", label: "375 × 812", width: 375, height: 812 },
] as const;

type ViewportPresetId = (typeof VIEWPORT_PRESETS)[number]["id"];

/** 缩放预设（参考图：适应窗口 / 50% / 75% / 100%）。`scale: null` = 适应视口。 */
const ZOOM_PRESETS = [
  { id: "fit", label: "适应窗口", scale: null },
  { id: "half", label: "50%", scale: 0.5 },
  { id: "three-quarter", label: "75%", scale: 0.75 },
  { id: "full", label: "100%", scale: 1 },
] as const;

type ZoomPresetId = (typeof ZOOM_PRESETS)[number]["id"];

/** 补全协议：裸地址（如 localhost:3000）按 http 处理；空串返回 null。 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}
