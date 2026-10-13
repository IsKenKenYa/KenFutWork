import { Button } from "@zui/components/ui/button.js";
import { Input } from "@zui/components/ui/input.js";
import { toast } from "@zui/components/ui/toast.js";
import { useZCodeSessionStore } from "@zui/store/zcodeSessionStore.js";
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  HistoryIcon,
  RotateCw,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSurfaceApiBase, surfaceJson } from "./surfaceApi.js";

/**
 * 内嵌浏览器面板（G1/Q3-Q5，KenFutWork 宿主件）：旧 panel-browser-view/live 的
 * CDP MJPEG 形态在 ZCode 右栏页签的重实现。
 *
 * 数据面（cookie 会话）：/api/browser/cdp/{status,connect,view,input,console}，
 * 画面流 GET /api/browser/cdp/stream?ticket=…（票据在 query，img 不带登录头）。
 * 交互按视口 CSS 坐标回填（显示盒线性映射）；键盘走 1px 透明 textarea（输入法合成可达）。
 * 面板内历史栈（跨源 iframe 读不到页面自己的 history）；视口预设是真视口（非缩放伪装）。
 * Q5 元素拾取：/api/browser/snapshot 取带真实盒模型的元素列表 → 视口叠框点选 →
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

/** 拾取候选元素（服务端 readPickables：DOM.getBoxModel 真实盒模型，视口坐标）。 */
interface PickableElement {
  tag: string;
  text: string;
  hint: string;
  box: { x: number; y: number; width: number; height: number } | null;
}

interface PickSnapshot {
  snapshot: {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    elements: PickableElement[];
  };
  source: "cdp" | "static";
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

const VIEWPORT_PRESETS: ReadonlyArray<{
  label: string;
  width: number;
  height: number;
}> = [
  { label: "1280 × 720", width: 1280, height: 720 },
  { label: "1024 × 768", width: 1024, height: 768 },
  { label: "375 × 812", width: 375, height: 812 },
];

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
  const [urlInput, setUrlInput] = useState(initialUrl ?? "");
  const [activeUrl, setActiveUrl] = useState(initialUrl ?? "");
  /** 面板内历史栈（页面跨源，读不到它自己的 history）。 */
  const [history, setHistory] = useState<string[]>(
    initialUrl ? [initialUrl] : [],
  );
  const [historyIndex, setHistoryIndex] = useState(initialUrl ? 0 : -1);
  const [frameSize, setFrameSize] = useState<(typeof VIEWPORT_PRESETS)[number]>(
    VIEWPORT_PRESETS[0] ?? { label: "1280 × 720", width: 1280, height: 720 },
  );
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<
    | { status: "connecting" }
    | { status: "live"; src: string }
    | { status: "error"; message: string }
  >({ status: "connecting" });
  const [viewport, setViewport] = useState<CdpViewport>({
    width: 0,
    height: 0,
    scale: 1,
  });
  /** Q5 拾取态：元素盒（视口坐标）+ 拾取视口尺寸；null=未在拾取。 */
  const [pick, setPick] = useState<{
    elements: PickableElement[];
    viewport: { width: number; height: number };
  } | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const draggingRef = useRef(false);
  const lastHoverRef = useRef(0);
  const retriesRef = useRef(0);
  const lastReloadRef = useRef(reloadToken);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const openRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    retriesRef.current = 0;
  }, [activeUrl, frameSize, reloadToken]);

  const open = useCallback(async () => {
    if (!activeUrl || frameSize.width <= 0) return;
    const forceReload = lastReloadRef.current !== reloadToken;
    lastReloadRef.current = reloadToken;
    setState({ status: "connecting" });
    try {
      const status = await surfaceJson<CdpStatus>("/api/browser/cdp/status");
      if (status.status !== "connected") {
        const connected = await surfaceJson<CdpStatus>(
          "/api/browser/cdp/connect",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ headless: true }),
          },
        );
        if (connected.status !== "connected") {
          throw new Error(
            connected.status === "error"
              ? (connected.message ?? "浏览器启动失败。")
              : "浏览器启动失败。",
          );
        }
      }
      const opened = await surfaceJson<{
        ticket: string;
        viewport: CdpViewport;
      }>("/api/browser/cdp/view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: activeUrl,
          width: frameSize.width,
          height: frameSize.height,
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
  }, [activeUrl, frameSize, reloadToken]);
  openRef.current = open;

  useEffect(() => {
    void open();
  }, [open]);

  const handleFrameError = useCallback(() => {
    if (retriesRef.current >= 2) {
      setState({
        status: "error",
        message: "画面已断开（浏览器可能被关闭）。",
      });
      return;
    }
    retriesRef.current += 1;
    void openRef.current();
  }, []);

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
      const rect =
        imgRef.current?.getBoundingClientRect() ??
        viewerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return toViewportPoint(rect, event, viewportRef.current);
    },
    [],
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (pick) return;
      sinkRef.current?.focus();
      const point = pointFrom(event);
      if (!point) return;
      const pressed =
        event.button === 2 ? "right" : event.button === 1 ? "middle" : "left";
      draggingRef.current = pressed === "left";
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
      if (pick) return;
      const point = pointFrom(event);
      draggingRef.current = false;
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
    [pointFrom, send],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (pick) return;
      const now = Date.now();
      if (!draggingRef.current && now - lastHoverRef.current < 120) return;
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
    const host = viewerRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      if (pick) return;
      event.preventDefault();
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
  }, [pick, pointFrom, send]);

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
    },
    [send],
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
      const next = raw.trim();
      if (!next) return;
      const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(next)
        ? next
        : `https://${next}`;
      setHistory((current) => [
        ...current.slice(0, historyIndex + 1),
        normalized,
      ]);
      setHistoryIndex((current) => current + 1);
      setActiveUrl(normalized);
      setUrlInput(normalized);
    },
    [historyIndex],
  );

  const goHistory = useCallback(
    (delta: number) => {
      const nextIndex = historyIndex + delta;
      const target = history[nextIndex];
      if (target === undefined) return;
      setHistoryIndex(nextIndex);
      setActiveUrl(target);
      setUrlInput(target);
    },
    [history, historyIndex],
  );

  const injectConsole = useCallback(async () => {
    if (!activeUrl) {
      toast("先打开一个页面再注入调试控制台。");
      return;
    }
    try {
      await surfaceJson("/api/browser/cdp/console", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: activeUrl }),
      });
      toast("调试控制台已注入页面");
    } catch (error) {
      toast(error instanceof Error ? error.message : "注入失败。");
    }
  }, [activeUrl]);

  /** Q5：进入/退出拾取。进入时拉一次带盒模型的元素快照。 */
  const togglePicking = useCallback(async () => {
    if (pick) {
      setPick(null);
      return;
    }
    if (!activeUrl) {
      toast("先打开一个页面再拾取元素。");
      return;
    }
    try {
      const result = await surfaceJson<PickSnapshot>("/api/browser/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: activeUrl }),
      });
      setPick({
        elements: result.snapshot.elements,
        viewport: result.snapshot.viewport,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "读取页面元素失败。");
    }
  }, [activeUrl, pick]);

  /** Q5：点选元素 → 生成坐标引用 → 填进 composer（草稿态；与插件提及同语义）。 */
  const insertElementReference = useCallback(
    (element: PickableElement) => {
      if (!element.box || !pick) return;
      const centerX = Math.round(element.box.x + element.box.width / 2);
      const centerY = Math.round(element.box.y + element.box.height / 2);
      const label = element.text.trim();
      const reference = [
        `【页面元素】<${element.tag}>${label ? ` ${label}` : ""}`,
        ` ｜ 定位提示：${element.hint.trim() || "无"}`,
        ` ｜ 中心坐标：${centerX},${centerY}`,
        ` ｜ 视口：${pick.viewport.width}×${pick.viewport.height}`,
        ` ｜ 来自：${activeUrl}`,
      ].join("");
      if (workspacePath) {
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(
            workspacePath,
            reference,
            workspaceIdentity,
          );
        toast("元素引用已填入输入框");
      } else {
        toast("当前工作区不可用，引用未填入");
      }
      setPick(null);
    },
    [activeUrl, pick, workspaceIdentity, workspacePath],
  );

  // 拾取中按 Esc 退出（与「再点一次工具栏按钮」等价）。
  useEffect(() => {
    if (!pick) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPick(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pick]);

  const canBack = historyIndex > 0;
  const canForward = historyIndex < history.length - 1;
  const scalePercent = useMemo(
    () => Math.round(viewport.scale > 0 ? viewport.scale * 100 : 100),
    [viewport.scale],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="browser-pane"
    >
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="后退"
          disabled={!canBack}
          onClick={() => goHistory(-1)}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="前进"
          disabled={!canForward}
          onClick={() => goHistory(1)}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="刷新"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          <RotateCw className="size-4" />
        </Button>
        <Input
          aria-label="地址栏"
          value={urlInput}
          onChange={(event) => setUrlInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") navigate(urlInput);
          }}
          className="h-7 flex-1 text-xs"
          placeholder="输入地址"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="调试控制台"
          onClick={() => void injectConsole()}
        >
          <SquareTerminal className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="拾取元素"
          aria-pressed={pick !== null}
          className={pick ? "bg-hover" : undefined}
          onClick={() => void togglePicking()}
        >
          <Crosshair className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-1.5 border-b px-2 py-1 text-xs">
        {VIEWPORT_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={`rounded px-1.5 py-0.5 transition-colors hover:bg-hover ${
              preset === frameSize
                ? "bg-hover font-medium"
                : "text-foreground-subtle"
            }`}
            onClick={() => setFrameSize(preset)}
          >
            {preset.label}
          </button>
        ))}
        {state.status === "live" ? (
          <span className="ml-auto inline-flex items-center gap-1 text-foreground-subtle">
            <HistoryIcon className="size-3" />
            {scalePercent}%
          </span>
        ) : null}
      </div>
      <div
        ref={viewerRef}
        role="group"
        aria-label="内嵌浏览器画面"
        className={`relative min-h-0 flex-1 overflow-hidden${pick ? " cursor-crosshair" : ""}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          draggingRef.current = false;
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {state.status === "live" ? (
          // MJPEG 流（multipart/x-mixed-replace）
          <img
            ref={imgRef}
            src={state.src}
            alt="浏览器画面"
            draggable={false}
            onError={handleFrameError}
            className="absolute top-0 left-0 h-full w-full select-none"
          />
        ) : state.status === "connecting" ? (
          <p className="p-2 text-xs text-foreground-subtle">
            正在打开内嵌浏览器…
          </p>
        ) : (
          <div className="p-2 text-xs">
            <p className="text-destructive">{state.message}</p>
            <button
              type="button"
              onClick={() => setReloadToken((token) => token + 1)}
              className="mt-1 rounded border px-1.5 py-0.5 hover:bg-hover"
            >
              重新加载
            </button>
          </div>
        )}
        {pick
          ? pick.elements.map((element, index) =>
              element.box ? (
                <button
                  key={`${element.tag}-${index}`}
                  type="button"
                  aria-label={`拾取 ${element.tag}`}
                  title={element.text || element.hint || element.tag}
                  className="absolute rounded-sm border border-primary/70 bg-primary/15 hover:border-primary hover:bg-primary/30"
                  style={{
                    left: `${(element.box.x / pick.viewport.width) * 100}%`,
                    top: `${(element.box.y / pick.viewport.height) * 100}%`,
                    width: `${(element.box.width / pick.viewport.width) * 100}%`,
                    height: `${(element.box.height / pick.viewport.height) * 100}%`,
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onMouseUp={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    insertElementReference(element);
                  }}
                />
              ) : null,
            )
          : null}
        {pick ? (
          <p className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/80 p-1 text-center text-xs text-foreground-subtle">
            点选元素填入输入框 · Esc 取消
          </p>
        ) : null}
      </div>
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
