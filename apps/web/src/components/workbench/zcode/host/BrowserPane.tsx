import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { Input } from "@zui/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { toast } from "@zui/components/ui/toast.js";
import { dispatchBrowserScreenshotAddToChat } from "@zui/lib/browserScreenshotChat.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Ellipsis,
  ExternalLink,
  Globe,
  MousePointerSquareDashed,
  PictureInPicture2,
  RotateCw,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSurfaceApiBase, surfaceJson } from "./surfaceApi.js";

/**
 * 内嵌浏览器面板（G1/Q3-Q5，KenFutWork 宿主件）：旧 panel-browser-view/live 的
 * CDP MJPEG 形态在 ZCode 右栏页签的重实现，**工具栏与自由尺寸行照旧版排布**：
 * 第一行 后退/前进/刷新/地址/自由尺寸开关/选择网页元素加入聊天/⋯菜单（在外部
 * 浏览器中打开、打开调试工具）；自由尺寸打开后第二行居中放 分辨率输入 + 窗口比例。
 *
 * 数据面（cookie 会话）：/api/browser/cdp/{status,connect,view,input,console,picker}，
 * 画面流 GET /api/browser/cdp/stream?ticket=…（票据在 query，img 不带登录头）。
 * 画面按**真实视口尺寸**排版再等比缩放（transform: scale）——比例永远不变形；
 * 自由尺寸关着时视口=面板可用区（scale 恒 1），打开后视口=输入的分辨率。
 * 交互按视口 CSS 坐标回填；键盘走 1px 透明 textarea（输入法合成可达）。
 * 面板内历史栈（跨源 iframe 读不到页面自己的 history）。
 * Q5 元素拾取：/api/browser/cdp/picker 往页面注入选择器脚本（DevTools 拾取器同款，
 * 高亮在页面里跟鼠标走）→ 面板转发一次「按下→抬起」→ read 取回元素 →
 * 坐标引用经 requestComposerTextInsert 填进 composer（草稿态生效，与插件提及同语义）。
 */

interface CdpStatus {
  status: "disconnected" | "connecting" | "connected" | "error";
  message?: string;
  currentUrl?: string;
}

interface CdpViewport {
  width: number;
  height: number;
  scale: number;
}

/** 页面内选择器点选回来的元素（elementFromPoint 实时取，坐标精确、全元素可选）。 */
interface PickedElementWire {
  tag: string;
  text: string;
  hint: string;
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  page: string;
}

interface CdpInputEvent {
  type: "mouse" | "wheel" | "key" | "text";
  action?: string;
  x?: number;
  y?: number;
  button?: string;
  buttons?: number;
  modifiers?: number;
  deltaX?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  text?: string;
}

type PaneState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "live"; src: string }
  | { status: "error"; message: string };

/** 缩放预设（旧版口径：适应窗口 / 50% / 75% / 100%）。`scale: null` = 适应面板。 */
const ZOOM_PRESETS = [
  { id: "fit", label: "适应窗口", scale: null },
  { id: "half", label: "50%", scale: 0.5 },
  { id: "three-quarter", label: "75%", scale: 0.75 },
  { id: "full", label: "100%", scale: 1 },
] as const;

type ZoomPresetId = (typeof ZOOM_PRESETS)[number]["id"];

/** view 重开的去抖间隔：拖面板宽/拖自由尺寸时避免每帧重开 MJPEG 流。 */
const VIEW_REOPEN_DEBOUNCE_MS = 180;

/** 修饰键位掩码（CDP）：Alt=1 / Ctrl=2 / Meta=4 / Shift=8。 */
function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) +
    (event.ctrlKey ? 2 : 0) +
    (event.metaKey ? 4 : 0) +
    (event.shiftKey ? 8 : 0)
  );
}

const IME_NOISE = new Set(["Process", "Unidentified", "Dead"]);

/** 有名字的键走按键转发；单字符（含组合键）走文本或不转发（剪贴板跨不过去）。 */
function isRemoteKeyEvent(event: {
  key: string;
  composing?: boolean;
}): boolean {
  if (event.composing) return false;
  if (event.key.length <= 1) return false;
  return !IME_NOISE.has(event.key);
}

function textToForward(event: {
  data: string | null;
  isComposing: boolean;
}): string | null {
  if (event.isComposing) return null;
  return event.data || null;
}

function toViewportPoint(
  rect: DOMRect,
  point: { clientX: number; clientY: number },
  viewport: CdpViewport,
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? viewport.width / rect.width : 1;
  const scaleY = rect.height > 0 ? viewport.height / rect.height : 1;
  const clamp = (value: number, min: number, max: number) =>
    Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
  return {
    x: clamp((point.clientX - rect.left) * scaleX, 0, viewport.width),
    y: clamp((point.clientY - rect.top) * scaleY, 0, viewport.height),
  };
}

/** 视口尺寸的夹取（自由尺寸的两个输入框与拖拽把手共用）。 */
function clampViewport(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 本地/内网地址判定（含带端口写法）：这些默认走 http。 */
export function looksLocal(value: string): boolean {
  const host = value.split("/")[0]?.split(":")[0]?.toLowerCase() ?? "";
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return (
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  }
  return false;
}

/**
 * 地址栏归一化（旧版口径）：裸主机名默认 https；本地/内网地址（localhost/
 * 127.0.0.1/*.local/私有网段/带端口）默认 http——这些基本没有证书，
 * 默认 https 只会白等一次失败。
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const scheme = looksLocal(trimmed) ? "http" : "https";
  return `${scheme}://${trimmed}`;
}

export function BrowserPane({
  initialUrl,
  workspacePath,
  workspaceIdentity,
}: {
  initialUrl?: string;
  /** 坐标引用填入 composer 所需（与插件提及同一 store 动作，草稿态生效）。 */
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [draft, setDraft] = useState(initialUrl ?? "");
  /** 面板内历史栈（页面跨源，读不到它自己的 history）。 */
  const [history, setHistory] = useState<string[]>(
    initialUrl ? [initialUrl] : [],
  );
  const [historyIndex, setHistoryIndex] = useState(initialUrl ? 0 : -1);
  const [reloadToken, setReloadToken] = useState(0);
  /** 自由尺寸开关（旧版口径：点一下打开、再点一下取消；行内容居中）。 */
  const [freeSizeOn, setFreeSizeOn] = useState(false);
  const [freeSize, setFreeSize] = useState({ width: 1280, height: 720 });
  const [zoom, setZoom] = useState<ZoomPresetId>("fit");
  // 无初始地址时不进 connecting——open() 会因 !url 直接返回，
  // 停在「正在打开」就成了永不结束的假加载；idle 是可用的开始态。
  const [state, setState] = useState<PaneState>(
    initialUrl ? { status: "connecting" } : { status: "idle" },
  );
  const [viewport, setViewport] = useState<CdpViewport>({
    width: 0,
    height: 0,
    scale: 1,
  });
  /**
   * 控制台打开期间藏本地光标：页面里画了跟手的自绘光标（截图流不含系统光标，
   * CSS cursor 传不过来——ns-resize 等提示只能在画面里画）。进拾取 / 换页 /
   * 卸载时恢复本地光标。
   */
  const [consoleCursorHidden, setConsoleCursorHidden] = useState(false);

  const imgRef = useRef<HTMLImageElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const draggingRef = useRef(false);
  const lastHoverRef = useRef(0);
  const retriesRef = useRef(0);
  const lastReloadRef = useRef(reloadToken);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const openRef = useRef<() => Promise<void>>(async () => {});

  /** 面板里这块预览区有多大（自由尺寸关着时视口 = 它，scale 恒 1 不变形）。 */
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const measure = () => {
      const el = frameRef.current;
      if (!el) return;
      setPaneSize((current) =>
        current.width === el.clientWidth && current.height === el.clientHeight
          ? current
          : { width: el.clientWidth, height: el.clientHeight },
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(frameRef.current ?? document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [url]);

  const viewportWidth = freeSizeOn ? freeSize.width : paneSize.width;
  const viewportHeight = freeSizeOn ? freeSize.height : paneSize.height;
  const fitScale =
    viewportWidth > 0 && viewportHeight > 0
      ? Math.min(
          1,
          paneSize.width / viewportWidth,
          paneSize.height / viewportHeight,
        )
      : 1;
  const zoomPreset = ZOOM_PRESETS.find((p) => p.id === zoom);
  const scale = zoomPreset?.scale ?? fitScale;
  /** 画面小于面板时水平/垂直居中（贴边显示上半截是旧版的观感缺口）；超出面板则回 0 可滚动。 */
  const displayWidth = viewportWidth * scale;
  const displayHeight = viewportHeight * scale;
  const frameOffsetLeft = Math.max(0, (paneSize.width - displayWidth) / 2);
  const frameOffsetTop = Math.max(0, (paneSize.height - displayHeight) / 2);

  useEffect(() => {
    retriesRef.current = 0;
  }, [url, viewportWidth, viewportHeight, reloadToken]);

  const open = useCallback(async () => {
    if (!url || viewportWidth <= 0 || viewportHeight <= 0) return;
    const forceReload = lastReloadRef.current !== reloadToken;
    lastReloadRef.current = reloadToken;
    setState({ status: "connecting" });
    try {
      // 服务端这几个端点的信封与设置页适配器一致：`{ cdp: {...} }`。
      const status = await surfaceJson<{ cdp: CdpStatus }>(
        "/api/browser/cdp/status",
      );
      if (status.cdp.status !== "connected") {
        const connected = await surfaceJson<{ cdp: CdpStatus }>(
          "/api/browser/cdp/connect",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ headless: true }),
          },
        );
        if (connected.cdp.status !== "connected") {
          throw new Error(
            connected.cdp.status === "error"
              ? (connected.cdp.message ?? "浏览器启动失败。")
              : "浏览器启动失败。",
          );
        }
      }
      setConsoleCursorHidden(false);
      const opened = await surfaceJson<{
        ticket: string;
        viewport: CdpViewport;
      }>("/api/browser/cdp/view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url,
          width: Math.round(viewportWidth),
          height: Math.round(viewportHeight),
          ...(forceReload ? { reload: true } : {}),
        }),
      });
      setViewport(opened.viewport);
      setState({
        status: "live",
        src: `${getSurfaceApiBase()}/api/browser/cdp/stream?ticket=${encodeURIComponent(opened.ticket)}`,
      });
    } catch (error: unknown) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "画面打开失败。",
      });
    }
  }, [url, viewportWidth, viewportHeight, reloadToken]);
  openRef.current = open;

  // 地址/尺寸/刷新变化 → 去抖后重开画面流（拖自由尺寸时每帧只保留最后一击）。
  useEffect(() => {
    if (!url) return;
    const timer = window.setTimeout(() => void open(), VIEW_REOPEN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [url, open]);

  const send = useCallback((event: CdpInputEvent) => {
    surfaceJson("/api/browser/cdp/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch((error: unknown) => {
      toast(error instanceof Error ? error.message : "操作没能送达浏览器。");
    });
  }, []);

  const pointFrom = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect = imgRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return toViewportPoint(rect, event, viewportRef.current);
    },
    [],
  );

  /**
   * 元素选择模式（DevTools 拾取器同款，参考 Edge「将元素添加到对话」）：进入时给页面
   * 注入跟随鼠标的选择器脚本——高亮在**页面里**实时画（elementFromPoint），坐标永远
   * 精确、所有元素可选；旧「快照+面板叠框」因错位与元素不全废弃。
   *
   * 退出必须**两侧一起收**（面板状态 + 页面里注入的选择器）：只清面板会留「僵尸选择器」
   * ——高亮照常跟鼠标走，点击却被页面拦截且永远没人来 read，元素进不了对话（真机踩过）。
   */
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  pickingRef.current = picking;

  const stopPicking = useCallback(() => {
    setPicking(false);
    surfaceJson("/api/browser/cdp/picker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    }).catch(() => {});
  }, []);

  // 卸载（切内容标签 / HMR 重挂载）也要收掉页面选择器，否则留给下一棒一个僵尸。
  useEffect(() => {
    return () => {
      surfaceJson("/api/browser/cdp/picker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      }).catch(() => {});
    };
  }, []);

  const handleFrameError = useCallback(() => {
    if (retriesRef.current >= 2) {
      setState({
        status: "error",
        message: "画面已断开（浏览器可能被关闭）。",
      });
      return;
    }
    // 画面断线重连后页面状态未知（服务可能重启过）：在拾取就先收掉，别赌选择器还活着
    if (pickingRef.current) stopPicking();
    retriesRef.current += 1;
    void openRef.current();
  }, [stopPicking]);

  /**
   * Q5：点选元素 → 生成坐标引用 → 填进 composer，**拾取不退出，可连续添加多个**。
   * chip 缩略形态（用户口径）：只显示标签名（`<a>`），悬浮 title 显示完整标签
   * （`<a> Learn more`）；发给模型的正文仍是完整 markdown——label 带元素文字、
   * target 是 browser-element:// 链接，坐标/视口/来源/定位提示都在 query 里，
   * agent 可直接取 x/y 用 browser_act 点它。走 prepend-if-missing：保留编辑器
   * 已有内容（含上一个 chip），新 chip 前插。
   */
  const insertElementReference = useCallback(
    (element: PickedElementWire) => {
      const centerX = Math.round(element.box.x + element.box.width / 2);
      const centerY = Math.round(element.box.y + element.box.height / 2);
      const tagLabel = `<${element.tag}>`;
      const fullLabel = element.text.trim()
        ? `${tagLabel} ${element.text.trim()}`
        : tagLabel;
      const params = new URLSearchParams({
        x: String(centerX),
        y: String(centerY),
        w: String(element.viewport.width),
        h: String(element.viewport.height),
        from: element.page || url,
      });
      const hint = element.hint.trim();
      if (hint) params.set("hint", hint);
      const target = `browser-element://pick?${params.toString()}`;
      const markdown = `[${fullLabel.replace(/]/g, "\\]")}](${target})`;
      if (workspacePath) {
        useZCodeSessionStore.getState().requestComposerTextInsert(
          workspacePath,
          markdown,
          workspaceIdentity,
          {
            id: `browser-element:${Date.now()}`,
            category: "browser",
            label: tagLabel,
            value: target,
            markdown,
            description: fullLabel,
          },
          "prepend-if-missing",
        );
        toast(`已添加 ${tagLabel}`);
      } else {
        toast("当前工作区不可用，引用未填入");
      }
    },
    [url, workspaceIdentity, workspacePath],
  );

  /** 拾取点选：页面在 mousedown 时已把元素存好；取回填 chip 后**不退出**（连续添加）。 */
  const readPickedAndInsert = useCallback(async () => {
    try {
      const result = await surfaceJson<{
        picked: PickedElementWire | null;
        active: boolean;
        error: string | null;
      }>("/api/browser/cdp/picker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "read" }),
      });
      if (result.error) {
        toast(result.error);
        return;
      }
      // 页面侧选择器已经没了（Esc 被页面收掉 / 页面导航过）：面板同步退出，
      // 别留在「按钮亮着但点击没反应」的假拾取态（真机踩过）。
      if (!result.active) {
        setPicking(false);
        return;
      }
      if (!result.picked) {
        // 点在了选择器自己的图层或空白处：保持选择模式，用户重试
        return;
      }
      // 连续拾取：填完不退出，页面选择器仍激活；Esc / 再点工具栏按钮才退出
      insertElementReference(result.picked);
    } catch {
      // 读取失败（服务重启窗口/网络抖动）：两侧一起收，别留僵尸选择器
      stopPicking();
    }
  }, [insertElementReference, stopPicking]);

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      sinkRef.current?.focus();
      const point = pointFrom(event);
      if (!point) return;
      const pressed =
        event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      // 拾取中同样要转发按下——页面内选择器正是在 mousedown 时记录元素并拦截
      // 这次点击（页面自身不会被点下去）；只是不算拖拽，保持悬停节流。
      draggingRef.current = pressed === "left" && !pickingRef.current;
      send({
        type: "mouse",
        action: "pressed",
        x: point.x,
        y: point.y,
        button: pressed,
        buttons: pressed === "left" ? 1 : pressed === "right" ? 2 : 4,
        modifiers: modifiersOf(event),
      });
    },
    [pointFrom, send],
  );

  const handleMouseUp = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const point = pointFrom(event);
      draggingRef.current = false;
      // 拾取中：这次「按下→抬起」就是点选，页面已把元素存好，取回并填进 composer。
      if (pickingRef.current) {
        if (!point) return;
        send({
          type: "mouse",
          action: "released",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 0,
        });
        void readPickedAndInsert();
        return;
      }
      if (!point) return;
      send({
        type: "mouse",
        action: "released",
        x: point.x,
        y: point.y,
        button: event.button === 2 ? "right" : "left",
        buttons: 0,
        modifiers: modifiersOf(event),
      });
    },
    [pointFrom, readPickedAndInsert, send],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const now = Date.now();
      // 恒 40ms：拾取高亮/自绘光标/控制台拖动都要跟手（拖拽中不限流）
      const throttle = 40;
      if (!draggingRef.current && now - lastHoverRef.current < throttle) return;
      lastHoverRef.current = now;
      const point = pointFrom(event);
      if (!point) return;
      send({
        type: "mouse",
        action: "moved",
        x: point.x,
        y: point.y,
        button: draggingRef.current ? "left" : "none",
        buttons: draggingRef.current ? 1 : 0,
        modifiers: modifiersOf(event),
      });
    },
    [pointFrom, send],
  );

  useEffect(() => {
    const host = frameRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      const point = pointFrom(event);
      if (!point) return;
      const factor = event.deltaMode === 1 ? 16 : 1;
      send({
        type: "wheel",
        x: point.x,
        y: point.y,
        deltaX: event.deltaX * factor,
        deltaY: event.deltaY * factor,
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [pointFrom, send]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        !isRemoteKeyEvent({
          key: event.key,
          composing: event.nativeEvent.isComposing,
        })
      ) {
        return;
      }
      event.preventDefault();
      send({
        type: "key",
        key: event.key,
        code: event.code,
        modifiers: modifiersOf(event),
      });
      // Esc 已转发给页面（页面选择器会自己收起）：稍后探活一次，
      // 页面侧没了就把面板拾取态也收掉——否则按钮亮着但点击没反应（假拾取态）。
      if (pickingRef.current && event.key === "Escape") {
        window.setTimeout(() => {
          void readPickedAndInsert();
        }, 150);
      }
    },
    [readPickedAndInsert, send],
  );

  const handleInput = useCallback(
    (event: React.FormEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent as InputEvent;
      const text = textToForward({
        data: native.data ?? null,
        isComposing: native.isComposing,
      });
      event.currentTarget.value = "";
      if (text) send({ type: "text", text });
    },
    [send],
  );

  /** 地址栏提交：压栈并导航。 */
  const navigate = useCallback(
    (raw: string) => {
      const normalized = normalizeUrl(raw);
      if (!normalized) return;
      setHistory((current) => [
        ...current.slice(0, historyIndex + 1),
        normalized,
      ]);
      setHistoryIndex((current) => current + 1);
      setUrl(normalized);
      setDraft(normalized);
    },
    [historyIndex],
  );

  const goHistory = useCallback(
    (delta: number) => {
      const nextIndex = historyIndex + delta;
      const target = history[nextIndex];
      if (target === undefined) return;
      setHistoryIndex(nextIndex);
      setUrl(target);
      setDraft(target);
    },
    [history, historyIndex],
  );

  /**
   * 打开调试工具（旧版口径）：Web 形态注入页面内控制台（Eruda 悬浮窗，
   * 可拖可关）。受控浏览器没连就先连上再注入——点一下就该能用，不摆假开关。
   */
  /** 调试控制台注入在途标记：一个页面只开一个，菜单连点/双触发不重入。 */
  const consoleInflightRef = useRef(false);
  const injectConsole = useCallback(async () => {
    const target = url || normalizeUrl(draft) || "about:blank";
    // 控制台悬浮窗会盖住页面：在拾取先退出（与进拾取自动收控制台对偶）
    if (pickingRef.current) stopPicking();
    if (consoleInflightRef.current) return;
    consoleInflightRef.current = true;
    try {
      const status = await surfaceJson<{ cdp: CdpStatus }>(
        "/api/browser/cdp/status",
      );
      if (status.cdp.status !== "connected") {
        const connected = await surfaceJson<{ cdp: CdpStatus }>(
          "/api/browser/cdp/connect",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ headless: true }),
          },
        );
        if (connected.cdp.status !== "connected") {
          throw new Error(
            connected.cdp.status === "error"
              ? (connected.cdp.message ?? "浏览器启动失败。")
              : "浏览器启动失败。",
          );
        }
      }
      await surfaceJson("/api/browser/cdp/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      setConsoleCursorHidden(true);
      toast("调试控制台已打开（面板页面里的悬浮窗，可拖可关）");
    } catch (error) {
      toast(error instanceof Error ? error.message : "打开调试工具失败。");
    } finally {
      consoleInflightRef.current = false;
    }
  }, [draft, stopPicking, url]);

  const openInSystemBrowser = useCallback(() => {
    if (url) window.open(url, "_blank", "noopener");
  }, [url]);

  const togglePicking = useCallback(async () => {
    if (pickingRef.current) {
      stopPicking();
      return;
    }
    if (!url) {
      toast("先打开一个页面再拾取元素。");
      return;
    }
    setConsoleCursorHidden(false);
    // 控制台悬浮窗盖在页面上会挡住元素：进拾取先收起（失败不阻塞拾取）
    surfaceJson("/api/browser/cdp/console", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "close" }),
    }).catch(() => {});
    try {
      await surfaceJson("/api/browser/cdp/picker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      setPicking(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : "进入元素选择失败。");
    }
  }, [stopPicking, url]);

  /** 截图到对话：截当前视口（base64）组 PNG File，走附件事件进当前 composer。 */
  const screenshotToChat = useCallback(async () => {
    if (state.status !== "live") {
      toast("先打开一个页面再截图。");
      return;
    }
    try {
      const shot = await surfaceJson<{
        base64: string;
        width: number;
        height: number;
      }>("/api/browser/cdp/screenshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const bytes = Uint8Array.from(atob(shot.base64), (c) => c.charCodeAt(0));
      const file = new File(
        [bytes],
        `浏览器截图-${shot.width}x${shot.height}.png`,
        { type: "image/png" },
      );
      if (!workspacePath) {
        toast("当前会话不接收截图");
        return;
      }
      const dispatched = dispatchBrowserScreenshotAddToChat({
        title: null,
        file,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!dispatched) {
        toast("当前会话不接收截图");
        return;
      }
      toast("截图已加入对话");
    } catch (error) {
      toast(error instanceof Error ? error.message : "截图失败。");
    }
  }, [state.status, workspaceIdentity, workspacePath]);

  // 拾取中按 Esc 退出（页面内 Esc 也会自行收起，这里是面板侧兜底）。
  useEffect(() => {
    if (!picking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") stopPicking();
    };
    // capture：拾取点选后焦点常被 composer 抢走（插入即 requestFocus），
    // Lexical 可能吞掉 Esc 的冒泡；捕获阶段 window 先拿到，退出不依赖焦点在哪。
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [picking, stopPicking]);

  const canBack = historyIndex > 0;
  const canForward = historyIndex < history.length - 1;
  const navButtonClass =
    "shrink-0 p-1 text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40";

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-2"
      data-testid="browser-pane"
    >
      {/* 第一行：导航 + 地址栏 + 自由尺寸 + 元素拾取 + ⋯ 菜单（旧版排布） */}
      <form
        className="flex items-center gap-1 px-1"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(draft);
        }}
      >
        <button
          type="button"
          aria-label="后退"
          disabled={!canBack}
          title="后退"
          onClick={() => goHistory(-1)}
          className={navButtonClass}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          disabled={!canForward}
          title="前进"
          onClick={() => goHistory(1)}
          className={navButtonClass}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="刷新"
          disabled={!url}
          title="重新加载当前页面"
          onClick={() => setReloadToken((token) => token + 1)}
          className={navButtonClass}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <Input
          aria-label="地址"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              navigate(draft);
            }
          }}
          placeholder="输入网址后回车"
          className="h-7 min-w-0 flex-1 border-transparent bg-hover/40 px-2 text-xs focus-visible:bg-transparent"
        />
        {/* 自由尺寸开关：点一下打开、再点一下取消（旧版口径） */}
        <button
          type="button"
          aria-label={freeSizeOn ? "退出自由尺寸" : "自由尺寸"}
          aria-pressed={freeSizeOn}
          title={freeSizeOn ? "退出自由尺寸" : "自由尺寸"}
          onClick={() => setFreeSizeOn((current) => !current)}
          className={`shrink-0 p-1 transition-colors hover:bg-hover ${
            freeSizeOn
              ? "bg-hover text-foreground"
              : "text-foreground-subtle hover:text-foreground"
          }`}
          data-active={freeSizeOn}
        >
          <PictureInPicture2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="选择网页元素加入聊天"
          disabled={!url}
          title="选择页面元素加入对话"
          onClick={() => void togglePicking()}
          className={`${navButtonClass} ${picking ? "bg-hover text-foreground" : ""}`}
        >
          <MousePointerSquareDashed className="h-3.5 w-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="浏览器菜单"
              title="更多"
              className="shrink-0"
            >
              <Ellipsis className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem
              disabled={state.status !== "live"}
              onSelect={() => void screenshotToChat()}
            >
              <Camera className="h-3.5 w-3.5" />
              <span>截图到对话</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!url}
              onSelect={() => openInSystemBrowser()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>在默认浏览器中打开</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void injectConsole()}>
              <SquareTerminal className="h-3.5 w-3.5" />
              <span>打开调试工具</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </form>

      {/* 自由尺寸打开后只放两样（旧版口径），整组水平居中 */}
      {freeSizeOn ? (
        <div className="flex items-center justify-center gap-2 px-1 py-0.5 text-[11px]">
          <ViewportSizeInput
            ariaLabel="视口宽度"
            value={freeSize.width}
            min={320}
            max={3840}
            onCommit={(width) =>
              setFreeSize((current) => ({ ...current, width }))
            }
          />
          <span aria-hidden className="text-foreground-subtle">
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
          <Select
            value={zoom}
            onValueChange={(next) => {
              if (typeof next === "string") setZoom(next as ZoomPresetId);
            }}
          >
            <SelectTrigger
              aria-label="窗口比例"
              title="窗口比例"
              className="min-w-24 shrink-0 border-transparent bg-transparent px-1.5 py-0.5 text-[11px] font-medium"
              data-testid="browser-zoom-select"
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
      ) : null}

      {url ? (
        <div className="relative min-h-0 flex-1">
          <div
            ref={frameRef}
            role="group"
            aria-label="内嵌浏览器画面"
            className={`absolute inset-0 overflow-auto bg-background-alt/50${
              picking
                ? " cursor-crosshair"
                : // 控制台打开期间藏本地光标：页面里画了跟手的自绘光标（截图流
                  // 不含系统光标，双光标会打架）
                  consoleCursorHidden
                  ? " cursor-none"
                  : ""
            }`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              draggingRef.current = false;
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {/* 画面按真实视口尺寸排版再等比缩放（比例永远不变形），
                小于面板时水平垂直居中（computed offset），超出回 0 可滚动。
                分隔用主题细环+圆角+浅影（旧版无黑边口径），不用实色 border。 */}
            <div
              data-role="live-browser-frame"
              className="absolute overflow-hidden rounded-lg bg-card shadow-sm ring-1 ring-border"
              style={{
                left: frameOffsetLeft,
                top: frameOffsetTop,
                width: viewportWidth > 0 ? `${viewportWidth}px` : "100%",
                height: viewportHeight > 0 ? `${viewportHeight}px` : "100%",
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              {state.status === "live" ? (
                // MJPEG 流（multipart/x-mixed-replace）。拾取高亮由页面内脚本画
                // （DevTools 式 elementFromPoint 跟随鼠标），面板不再叠框。
                <div className="relative h-full w-full">
                  <img
                    ref={imgRef}
                    src={state.src}
                    alt="浏览器画面"
                    draggable={false}
                    onError={handleFrameError}
                    className="absolute top-0 left-0 h-full w-full select-none"
                  />
                </div>
              ) : state.status === "connecting" ? (
                <p className="p-2 text-xs text-foreground-subtle">
                  正在打开内嵌浏览器…
                </p>
              ) : state.status === "idle" ? null : (
                <div className="p-2 text-xs">
                  <p className="text-destructive">{state.message}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setReloadToken((token) => token + 1)}
                    className="mt-1"
                  >
                    重新加载
                  </Button>
                </div>
              )}
            </div>
            {freeSizeOn ? (
              <button
                type="button"
                aria-label="拖动调整尺寸"
                title="拖动调整尺寸"
                onMouseDown={(event) => {
                  event.preventDefault();
                  const startX = event.clientX;
                  const startY = event.clientY;
                  const start = freeSize;
                  const onMove = (moveEvent: MouseEvent) => {
                    setFreeSize({
                      width: clampViewport(
                        start.width + (moveEvent.clientX - startX),
                        320,
                        3840,
                      ),
                      height: clampViewport(
                        start.height + (moveEvent.clientY - startY),
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
                  left: `${frameOffsetLeft + displayWidth - 10}px`,
                  top: `${frameOffsetTop + displayHeight - 10}px`,
                }}
                className="absolute h-3 w-3 cursor-nwse-resize rounded-sm border border-foreground/40 bg-background"
                data-testid="browser-free-size-handle"
              />
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-foreground-subtle">
          <Globe className="size-10 opacity-30" />
          <p className="text-xs">还没有打开页面</p>
          {state.status === "idle" && !initialUrl ? (
            <p className="text-[11px]">输入地址开始浏览</p>
          ) : null}
        </div>
      )}
      <textarea
        ref={sinkRef}
        aria-label="浏览器键盘输入"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        className="absolute h-px w-px resize-none border-0 p-0 opacity-0 outline-none"
        style={{ left: 1, top: 1 }}
      />
    </div>
  );
}

/**
 * 自由尺寸的数字输入（旧版做法）：打字期间只在「解析出来且落在范围内」时提交，
 * 落焦时再夹一次并规范化文本（边打字边夹取会把「9」错夹成 320）。
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
      data-testid={`browser-free-size-${ariaLabel === "视口宽度" ? "width" : "height"}`}
      className="w-16 rounded-sm border-transparent bg-hover/40 px-1 py-0.5 font-mono text-[11px] tabular-nums outline-none focus:bg-transparent focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}
