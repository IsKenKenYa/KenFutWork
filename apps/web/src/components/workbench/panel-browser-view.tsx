"use client";

import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  Globe,
  Monitor,
  MousePointerSquareDashed,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getServerBaseUrl } from "@/lib/env";

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
/** 拾取到的元素（R3-4）：交给对话，作为「用户指着这个元素」的引用。 */
export interface PickedElement {
  pageUrl: string;
  pageTitle: string;
  tag: string;
  text: string;
  hint: string;
}

/**
 * 元素引用转成消息里的一行（纯函数，便于单测）。
 * 口径：让人和模型都能对上——元素是什么、在哪一页。
 */
export function formatElementReference(picked: PickedElement): string {
  const where = picked.pageTitle
    ? `${picked.pageTitle}（${picked.pageUrl}）`
    : picked.pageUrl;
  return `【页面元素】<${picked.tag}> ${picked.text || "(无文字)"} ｜ 定位提示：${picked.hint} ｜ 来自：${where}`;
}

export function BrowserPane({
  url,
  draft,
  reloadToken,
  canBack,
  canForward,
  accessToken = null,
  onPickElement,
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
  /** 读取页面快照（元素拾取）用；缺省时拾取入口禁用。 */
  accessToken?: string | null;
  /** 拾取到元素后交给对话（工作台把它写进输入框）。 */
  onPickElement?: ((picked: PickedElement) => void) | undefined;
  onDraftChange: (value: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
}) {
  const normalized = normalizeUrl(draft);
  const [viewportPreset, setViewportPreset] = useState<ViewportPresetId>("fit");
  /**
   * 自由尺寸（参考图的「退出自由尺寸」）：视口尺寸由用户自己拖/填——
   * 预设给常用档，自由尺寸给「就想看看 900px 宽什么样子」。
   */
  const [freeSize, setFreeSize] = useState({ width: 1280, height: 720 });
  const [zoom, setZoom] = useState<ZoomPresetId>("fit");
  /**
   * 元素拾取（R3-4）：服务端静态快照 → 列出可交互元素 → 点一条插入对话。
   * 跨源 iframe 读不到 DOM，所以走服务端抓取；脚本渲染出的内容与登录态页面读不到，
   * 这条边界写在浮层里（不写就只能靠猜为什么元素不全）。
   */
  const [picking, setPicking] = useState<
    "idle" | "loading" | "error" | "ready"
  >("idle");
  const [pickError, setPickError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{
    pageTitle: string;
    elements: Array<{ tag: string; text: string; hint: string }>;
  } | null>(null);

  const startPicking = async () => {
    if (!url) return;
    setPicking("loading");
    setPickError(null);
    setPicked(null);
    try {
      const response = await fetch(
        `${getServerBaseUrl()}/api/browser/snapshot`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({ url }),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        snapshot?: {
          title: string;
          elements: Array<{ tag: string; text: string; hint: string }>;
        };
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.snapshot) {
        setPicking("error");
        setPickError(payload?.error?.message ?? "读取页面结构失败。");
        return;
      }
      setPicked({
        pageTitle: payload.snapshot.title,
        elements: payload.snapshot.elements,
      });
      setPicking("ready");
    } catch (error) {
      setPicking("error");
      setPickError(
        error instanceof Error ? error.message : "读取页面结构失败。",
      );
    }
  };
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
  const viewportWidth =
    viewportPreset === "free"
      ? freeSize.width
      : (sizePreset.width ?? paneWidth);
  const viewportHeight =
    viewportPreset === "free"
      ? freeSize.height
      : (sizePreset.height ?? paneHeight);
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
          disabled={!url || !accessToken || picking === "loading"}
          title="拾取页面元素加入对话：按服务端抓取的静态 HTML 列出链接/按钮/输入等元素（脚本渲染与登录态内容读不到）"
          onClick={() => void startPicking()}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
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
        {/* 缩放读数只在**真的有一页在看**时出现：没开页面时面板还没量到尺寸，
            fitScale 会算出 0%（实测显示「1280 × 720 0%」这种没意义的读数） */}
        {url && viewportWidth !== paneWidth && scale !== 1 ? (
          <span className="text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
        ) : null}
        {viewportPreset === "free" ? (
          <span className="flex items-center gap-1">
            <ViewportSizeInput
              ariaLabel="视口宽度"
              value={freeSize.width}
              min={320}
              max={3840}
              onCommit={(width) =>
                setFreeSize((current) => ({ ...current, width }))
              }
            />
            <span aria-hidden className="text-muted-foreground">
              ×
            </span>
            <ViewportSizeInput
              ariaLabel="视口高度"
              value={freeSize.height}
              min={240}
              max={2160}
              onCommit={(height) =>
                setFreeSize((current) => ({ ...current, height }))
              }
            />
            <button
              type="button"
              aria-label="退出自由尺寸"
              title="退出自由尺寸（回到跟随面板）"
              onClick={() => setViewportPreset("fit")}
              className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              退出自由尺寸
            </button>
          </span>
        ) : null}
        <Select
          aria-label="视口预设"
          value={viewportPreset}
          onValueChange={(next) => {
            if (typeof next === "string")
              setViewportPreset(next as ViewportPresetId);
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

      {picking !== "idle" ? (
        <div
          role="dialog"
          aria-label="选择网页元素加入聊天"
          className="max-h-56 overflow-y-auto rounded-lg border bg-popover p-2 text-xs"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-medium">
              选择元素加入对话
              {picked?.pageTitle ? ` · ${picked.pageTitle}` : ""}
            </span>
            <button
              type="button"
              aria-label="关闭元素拾取"
              onClick={() => setPicking("idle")}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <p className="mb-2 text-[10px] text-muted-foreground">
            按服务端抓取的静态 HTML 列出；脚本渲染出的元素与登录态内容看不到。
          </p>
          {picking === "loading" ? (
            <p className="text-muted-foreground">正在读取页面结构…</p>
          ) : picking === "error" ? (
            <p className="text-destructive">{pickError}</p>
          ) : picked && picked.elements.length > 0 ? (
            <ul className="space-y-0.5">
              {picked.elements.map((element, index) => (
                <li key={`${element.hint}-${index}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onPickElement?.({
                        pageUrl: url,
                        pageTitle: picked.pageTitle,
                        tag: element.tag,
                        text: element.text,
                        hint: element.hint,
                      });
                      setPicking("idle");
                    }}
                    className="w-full rounded px-1.5 py-1 text-left hover:bg-muted"
                  >
                    <span className="mr-1.5 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                      {element.tag}
                    </span>
                    <span className="truncate">{element.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              这一页没提取到可交互元素（可能是脚本渲染的页面）。
            </p>
          )}
        </div>
      ) : null}

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
          {viewportPreset === "free" ? (
            <button
              type="button"
              aria-label="拖动调整视口尺寸"
              title="拖动调整视口尺寸"
              onMouseDown={(event) => {
                event.preventDefault();
                const startX = event.clientX;
                const startY = event.clientY;
                const start = freeSize;
                const onMove = (moveEvent: MouseEvent) => {
                  setFreeSize({
                    width: clampViewport(
                      Math.round(start.width + (moveEvent.clientX - startX)),
                      320,
                      3840,
                    ),
                    height: clampViewport(
                      Math.round(start.height + (moveEvent.clientY - startY)),
                      240,
                      2160,
                    ),
                  });
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
              style={{
                left: `${viewportWidth * scale - 10}px`,
                top: `${viewportHeight * scale - 10}px`,
              }}
              className="absolute h-3 w-3 cursor-nwse-resize rounded-sm border border-foreground/40 bg-background"
            />
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          还没有打开页面。对话里点链接会自动在这里打开，也可以在地址栏输入。
        </p>
      )}
      <p className="text-[10px] text-muted-foreground">
        内嵌页面能否显示取决于目标站点是否允许被嵌入；被拒绝时会是一片空白，用「在系统浏览器
        打开」兜底。后退 /
        前进记的是本面板打开过的地址（跨源页面自己的历史读不到）。
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
  { id: "free", label: "自由尺寸", width: null, height: null },
] as const;

/**
 * 自由尺寸的数字输入：**边打字边夹取是错的**（第一次按「9」，空值被夹成 320，接着变成 3209…）。
 * 做法：打字期间只在「解析出来且落在范围内」时提交，落焦时再夹一次并规范化文本。
 */
function ViewportSizeInput({
  ariaLabel,
  value,
  min,
  max,
  onCommit,
}: {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <input
      aria-label={ariaLabel}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const parsed = Number(next);
        if (
          next.trim() !== "" &&
          Number.isFinite(parsed) &&
          parsed >= min &&
          parsed <= max
        ) {
          onCommit(Math.round(parsed));
        }
      }}
      onBlur={() => {
        const parsed = Number(text);
        const clamped = clampViewport(parsed, min, max);
        setText(String(clamped));
        onCommit(clamped);
      }}
      className="w-16 rounded border bg-transparent px-1 py-0.5 font-mono text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

/** 视口尺寸的夹取（自由尺寸的两个输入框与拖拽把手共用）。 */
function clampViewport(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

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
