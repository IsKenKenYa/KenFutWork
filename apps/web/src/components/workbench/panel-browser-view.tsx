"use client";

import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  ExternalLink,
  MousePointerSquareDashed,
  PictureInPicture2,
  RotateCw,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  boundsOf,
  embedBounds,
  embedClose,
  embedDevtools,
  embedOpen,
  isDesktopShell,
} from "@/lib/desktop-embed";
import { getServerBaseUrl } from "@/lib/env";
import {
  connectCdp,
  fetchCdpStatus,
  injectDebugConsole,
} from "@/lib/server-api";
import { keyed } from "../list-keys";
import { BrowserLiveView } from "./panel-browser-live";
import { PanelEmptyState } from "./panel-view-icon";

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
 * - 「选择网页元素加入聊天」有两条路：**受控浏览器（CDP）连着**时走真实渲染页——
 *   服务端用 `DOM.getBoxModel` 取每个元素的盒模型并附一张视口截图，浮层在截图上叠框点选
 *   （点框即引用，含中心坐标，agent 可直接 `browser_act` 点它）；没连时回落服务端静态
 *   抓取的 HTML 元素列表（脚本渲染内容与登录态页面看不到，这条边界写在浮层里）。
 */
/** 拾取到的元素（R3-4）：交给对话，作为「用户指着这个元素」的引用。 */
export interface PickedElement {
  pageUrl: string;
  pageTitle: string;
  tag: string;
  text: string;
  hint: string;
  /** CDP 路径才有：元素边框盒（视口坐标，CSS px）。 */
  box?: { x: number; y: number; width: number; height: number } | undefined;
}

/**
 * 元素引用转成消息里的一行（纯函数，便于单测）。
 * 口径：让人和模型都能对上——元素是什么、在哪一页。
 * 有几何时补一个**中心坐标**：它就在受控浏览器视口里，agent 可以直接用
 * `browser_act` 的 x/y 点它（不用再去猜选择器）。
 */
export function formatElementReference(picked: PickedElement): string {
  const where = picked.pageTitle
    ? `${picked.pageTitle}（${picked.pageUrl}）`
    : picked.pageUrl;
  const position = picked.box
    ? ` ｜ 中心坐标：${Math.round(picked.box.x + picked.box.width / 2)},${Math.round(
        picked.box.y + picked.box.height / 2,
      )}（受控浏览器视口内，可直接用 browser_act 的 x/y 点它）`
    : "";
  return `【页面元素】<${picked.tag}> ${picked.text || "(无文字)"} ｜ 定位提示：${picked.hint}${position} ｜ 来自：${where}`;
}

/** 浮层里的一个可拾取元素（与服务端 `/api/browser/snapshot` 的元素形状一致）。 */
interface PickableEntry {
  tag: string;
  text: string;
  hint: string;
  box?:
    | { x: number; y: number; width: number; height: number }
    | null
    | undefined;
}

interface PickResult {
  pageTitle: string;
  elements: PickableEntry[];
  /** 受控浏览器的视口尺寸（把 box 的 px 换算成百分比要用它）。 */
  viewport?: { width: number; height: number } | undefined;
  /** 受控浏览器的视口截图（签了名的 URL）；缺省时浮层只列元素、不叠框。 */
  screenshotUrl?: string | undefined;
  source: "cdp" | "static";
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
  /**
   * **自由尺寸开关**（用户口径：按钮点一下打开、再点一下取消，名字就叫「自由尺寸 / 退出自由尺寸」）。
   * 打开后第二行**不管有没有页面都显示**，内容只有「分辨率（可编辑输入框）+ 窗口比例」。
   */
  const [freeSizeOn, setFreeSizeOn] = useState(false);
  /**
   * 自由尺寸（参考图的「退出自由尺寸」）：视口尺寸由用户自己拖/填——
   * 预设给常用档，自由尺寸给「就想看看 900px 宽什么样子」。
   */
  const [freeSize, setFreeSize] = useState({ width: 1280, height: 720 });
  const [zoom, setZoom] = useState<ZoomPresetId>("fit");
  /**
   * 元素拾取（R3-4）：服务端在**受控浏览器（CDP）连着**时给真实渲染页的元素盒模型 +
   * 视口截图 → 浮层在截图上叠框点选；没连时回落到服务端静态抓取的 HTML 元素列表。
   * 静态那条读不到脚本渲染内容与登录态页面，这条边界写在浮层里（不写就只能靠猜）。
   */
  /**
   * 受控浏览器在不在（决定「打开调试工具」这一项**真的能不能点**）。
   * 只有连上时才亮：没连时点它没有任何意义，亮着就是假开关。
   */
  /**
   * 是否跑在桌面外壳里：桌面用**真内核嵌入**（路线 2），Web 用 iframe。
   * 取值只在挂载后定（SSR 里没有 window）。
   */
  const [desktopShell, setDesktopShell] = useState(false);
  const embedSlotRef = useRef<HTMLDivElement>(null);
  const [cdpConnected, setCdpConnected] = useState(false);
  /** 结果用**全站既有的 toast** 呈现（用户口径：这类提示不要贴在面板里）。 */
  const { toast } = useToast();
  const [picking, setPicking] = useState<
    "idle" | "loading" | "error" | "ready"
  >("idle");
  const [pickError, setPickError] = useState<string | null>(null);
  const [picked, setPicked] = useState<PickResult | null>(null);
  /** 悬停高亮：列表行与截图上的框互相对照（索引一致）。 */
  const [hoveredElement, setHoveredElement] = useState<number | null>(null);

  const startPicking = async () => {
    if (!url) return;
    setPicking("loading");
    setPickError(null);
    setPicked(null);
    setHoveredElement(null);
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
          elements: PickableEntry[];
          viewport?: { width: number; height: number };
        };
        screenshotUrl?: string;
        source?: "cdp" | "static";
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
        viewport: payload.snapshot.viewport,
        screenshotUrl: payload.screenshotUrl,
        source: payload.source === "cdp" ? "cdp" : "static",
      });
      setPicking("ready");
    } catch (error) {
      setPicking("error");
      setPickError(
        error instanceof Error ? error.message : "读取页面结构失败。",
      );
    }
  };
  /** 点中一个元素（列表行与截图上的框共用）：交给对话并收起浮层。 */
  const pickElement = (element: PickableEntry) => {
    onPickElement?.({
      pageUrl: url,
      pageTitle: picked?.pageTitle ?? "",
      tag: element.tag,
      text: element.text,
      hint: element.hint,
      ...(element.box ? { box: element.box } : {}),
    });
    setPicking("idle");
    setHoveredElement(null);
  };
  /** 截图叠框要三个数都对得上：视口尺寸（换算比例）+ 截图 + 至少一个盒子。 */
  const overlay =
    picked?.viewport &&
    picked.viewport.width > 0 &&
    picked.viewport.height > 0 &&
    picked.elements.some((element) => element.box)
      ? {
          viewport: picked.viewport,
          elements: picked.elements,
        }
      : null;
  /** 面板里这块预览区有多大（「适应面板」时的视口尺寸 = 它）。 */
  const frameRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [paneHeight, setPaneHeight] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: url 只当触发器（量的是 DOM 尺寸）；换页后布局变化需要重新量
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

  const viewportWidth = freeSizeOn ? freeSize.width : paneWidth;
  const viewportHeight = freeSizeOn ? freeSize.height : paneHeight;
  const fitScale =
    viewportWidth > 0 && viewportHeight > 0
      ? Math.min(1, paneWidth / viewportWidth, paneHeight / viewportHeight)
      : 1;
  /**
   * 受控浏览器状态：只影响菜单里那行提示文案（这一项**不再置灰**——没连时点它就先连上再开
   * 调试工具，用户口径是「点一下就该能用」）。每 20 秒刷新一次，另外**菜单一打开也刷一次**，
   * 免得刚在设置页连上却要等轮询。
   */
  const refreshCdp = useCallback(() => {
    if (!accessToken) return;
    fetchCdpStatus(accessToken)
      .then((status) => setCdpConnected(status.status === "connected"))
      .catch(() => setCdpConnected(false));
  }, [accessToken]);

  useEffect(() => {
    refreshCdp();
    const timer = window.setInterval(refreshCdp, 20_000);
    return () => window.clearInterval(timer);
  }, [refreshCdp]);

  // 挂载后再判断形态（SSR 无 window）
  useEffect(() => {
    setDesktopShell(isDesktopShell());
  }, []);

  /**
   * 桌面形态：把面板里的占位块位置同步给原生子 webview。
   * 子 webview 不随网页滚动/裁剪，所以**滚轮、拖面板、切标签、面板开合都要重算**；
   * 面板不可见时隐藏它（比销毁便宜），离开时再关（effect 收尾）。
   */
  useEffect(() => {
    if (!desktopShell || !url) return;
    const slot = embedSlotRef.current;
    if (!slot) return;
    const push = () => {
      void embedBounds(boundsOf(slot));
    };
    void embedOpen(url, boundsOf(slot));
    push();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => push());
    observer?.observe(slot);
    window.addEventListener("resize", push);
    window.addEventListener("scroll", push, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", push);
      window.removeEventListener("scroll", push, true);
      void embedClose();
    };
  }, [desktopShell, url]);

  const zoomPreset = ZOOM_PRESETS.find((p) => p.id === zoom);
  const scale = zoomPreset?.scale ?? fitScale;

  const navButtonClass =
    "shrink-0 p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40";

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
          title="后退"
          onClick={onBack}
          className={navButtonClass}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          disabled={!canForward}
          title="前进"
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
          className="min-w-0 flex-1 border border-transparent bg-muted/60 px-2 py-1 text-xs outline-none focus:border-ring focus:bg-transparent"
        />
        {/*
          「尺寸」按钮照参考放在**地址栏这一行**（地址框与元素拾取之间），是**图标按钮**；
          用户口径：**点一下打开、再点一下取消**，名字就叫「自由尺寸 / 退出自由尺寸」。
        */}
        <button
          type="button"
          aria-label={freeSizeOn ? "退出自由尺寸" : "自由尺寸"}
          aria-pressed={freeSizeOn}
          title={freeSizeOn ? "退出自由尺寸" : "自由尺寸"}
          onClick={() => setFreeSizeOn((current) => !current)}
          className={`shrink-0 p-1 transition-colors hover:bg-muted ${
            freeSizeOn
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          data-active={freeSizeOn}
        >
          <PictureInPicture2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="选择网页元素加入聊天"
          disabled={!url || !accessToken || picking === "loading"}
          title="选择页面元素加入对话"
          onClick={() => void startPicking()}
          className="shrink-0 p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <MousePointerSquareDashed className="h-3.5 w-3.5" />
        </button>
        <Select
          aria-label="浏览器菜单"
          value=""
          onOpenChange={(open: boolean) => {
            if (open) refreshCdp();
          }}
          onValueChange={(next) => {
            if (next === "open-system" && url) {
              window.open(url, "_blank", "noopener");
            }
            if (next === "devtools" && accessToken) {
              /**
               * 「打开调试工具」**按环境自动分流**（用户口径：不要「完整调试工具」那一项）：
               * - 桌面形态：页面就在我们自己的 WebView2 里 → 直接开它的 DevTools（同一内核的真身）；
               * - Web 形态：把现成的页面内控制台（Eruda）注入面板显示的这一页，并摆成悬浮窗。
               *
               * 只有 Web 形态才需要受控浏览器（注入走 CDP）——桌面形态连它等于白起一个实例。
               */
              const token = accessToken;
              const target = url || normalized || "about:blank";
              const run = async () => {
                try {
                  if (desktopShell) {
                    await embedDevtools();
                    toast("调试工具已打开（WebView2 DevTools）");
                    return;
                  }
                  if (!cdpConnected) {
                    const status = await connectCdp(token, { headless: true });
                    if (status.status !== "connected") {
                      throw new Error(
                        status.status === "error"
                          ? status.message
                          : "浏览器启动失败。",
                      );
                    }
                    setCdpConnected(true);
                  }
                  await injectDebugConsole(token, target);
                  toast("调试控制台已打开（面板页面里的悬浮窗，可拖可关）");
                } catch (error: unknown) {
                  toast(
                    error instanceof Error
                      ? error.message
                      : "打开调试工具失败。",
                    "error",
                  );
                }
              };
              void run();
            }
          }}
          items={[
            { value: "open-system", label: "在默认浏览器中打开" },
            { value: "devtools", label: "打开调试工具" },
          ]}
        >
          <SelectTrigger
            className="shrink-0 gap-0 rounded-none border-transparent px-1.5 py-1"
            aria-label="浏览器菜单"
            hideChevron
            title="更多"
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </SelectTrigger>
          <SelectContent className="min-w-52 rounded-none">
            {/* 菜单形态照参考：**两项、各带图标、不写任何括号说明**（用户口径「这一块的说明不要」） */}
            <SelectItem value="open-system" className="rounded-none">
              <span className="flex items-center gap-2">
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                在默认浏览器中打开
              </span>
            </SelectItem>
            {/*
              调试工具：参考里有，但**iframe 路径给不了**——浏览器不允许给 iframe 单独开 devtools
              （只能从外层页面的 devtools 里选 frame）。按「不摆假开关」的规矩置灰；原因只放在
              悬停提示里，不进列表正文（用户口径：列表里的说明不要）。
            */}
            <SelectItem
              value="devtools"
              className="rounded-none"
              title={
                cdpConnected
                  ? "打开调试工具（桌面形态开 WebView2 DevTools，Web 形态注入页面内控制台）"
                  : "会先连接受控浏览器，再打开调试工具"
              }
            >
              <span className="flex items-center gap-2">
                <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
                打开调试工具
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
      </form>

      {/*
        自由尺寸打开后**只放两样**（用户口径：「只要分辨率（可编辑，输入框）+ 窗口比例」），
        而且**不管有没有页面都显示**——所以这里不再看 url 有没有值。
      */}
      {freeSizeOn ? (
        /* 用户口径「这个居中」：分辨率 + 比例**整组水平居中**（比例不再被顶到最右） */
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
          <Select
            aria-label="窗口比例"
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
              className="shrink-0 gap-1 rounded-none border-transparent bg-transparent px-1.5 py-0.5 text-[11px]"
              aria-label="窗口比例"
              title="窗口比例"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="min-w-28 rounded-none">
              {ZOOM_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {picking !== "idle" ? (
        <div
          role="dialog"
          aria-label="选择网页元素加入聊天"
          className="max-h-72 overflow-y-auto border bg-popover p-2 text-xs"
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
              className="p-0.5 text-muted-foreground hover:bg-muted"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {picking === "loading" ? (
            <p className="text-muted-foreground">正在读取页面结构…</p>
          ) : picking === "error" ? (
            <p className="text-destructive">{pickError}</p>
          ) : picked ? (
            <>
              <p className="mb-2 text-[10px] text-muted-foreground">
                {picked.source === "cdp"
                  ? "来源：实时页面"
                  : "来源：页面快照（可能缺少动态内容）"}
              </p>

              {/* 截图叠框：几何来自 DOM.getBoxModel，坐标是视口 CSS px，
                  换算成百分比后与截图（同一视口尺寸）严丝合缝 */}
              {overlay && picked.screenshotUrl ? (
                <div className="relative mb-2 overflow-hidden border">
                  {/* biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用 */}
                  <img
                    src={picked.screenshotUrl}
                    alt={`${picked.pageTitle || url} 的视口截图`}
                    className="block w-full"
                  />
                  {keyed(overlay.elements, (element) => element.hint).map(
                    ({ key, item: element }, index) =>
                      element.box ? (
                        <button
                          key={key}
                          type="button"
                          aria-label={`拾取元素 ${index + 1}：${element.tag} ${element.text}`}
                          title={`<${element.tag}> ${element.text || "(无文字)"}`}
                          onMouseEnter={() => setHoveredElement(index)}
                          onMouseLeave={() => setHoveredElement(null)}
                          onClick={() => pickElement(element)}
                          style={{
                            left: `${(element.box.x / overlay.viewport.width) * 100}%`,
                            top: `${(element.box.y / overlay.viewport.height) * 100}%`,
                            width: `${(element.box.width / overlay.viewport.width) * 100}%`,
                            height: `${(element.box.height / overlay.viewport.height) * 100}%`,
                          }}
                          className={`absolute border transition-colors ${
                            hoveredElement === index
                              ? "border-info bg-info/30"
                              : "border-info/70 bg-info/10 hover:bg-info/30"
                          }`}
                        >
                          <span className="absolute -top-3 -left-px bg-info px-1 text-[9px] leading-3 text-white">
                            {index + 1}
                          </span>
                        </button>
                      ) : null,
                  )}
                </div>
              ) : null}

              {picked.elements.length > 0 ? (
                <ul className="space-y-0.5">
                  {keyed(picked.elements, (element) => element.hint).map(
                    ({ key, item: element }, index) => (
                      <li key={key}>
                        <button
                          type="button"
                          onMouseEnter={() => setHoveredElement(index)}
                          onMouseLeave={() => setHoveredElement(null)}
                          onClick={() => pickElement(element)}
                          className={`w-full px-1.5 py-1 text-left ${
                            hoveredElement === index
                              ? "bg-muted"
                              : "hover:bg-muted"
                          }`}
                        >
                          {overlay && element.box ? (
                            <span className="mr-1.5 bg-info/15 px-1 py-0.5 font-mono text-[10px] text-info">
                              {index + 1}
                            </span>
                          ) : null}
                          <span className="mr-1.5 bg-muted px-1 py-0.5 font-mono text-[10px]">
                            {element.tag}
                          </span>
                          <span className="truncate">
                            {element.text || "(无文字)"}
                          </span>
                          {element.box ? (
                            <span className="ml-1.5 text-[10px] text-muted-foreground">
                              {Math.round(element.box.x)},
                              {Math.round(element.box.y)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="text-muted-foreground">这一页没有可选的元素。</p>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {url ? (
        <div className="relative min-h-0 flex-1">
          <div
            ref={frameRef}
            className="absolute inset-0 overflow-auto border bg-background"
          >
            {/*
            桌面形态（路线 2）：页面由 Rust 侧的**真 WebView2 子 webview** 渲染，
            这里只留一个占位块——它的位置会同步给原生层（见上面的同步 effect）。
            占位块保持透明但要占位，否则面板布局会塌。

            其余形态：面板显示的是**受控浏览器的实时画面**（不是 iframe）——
            跨源 iframe 读不到 DOM、挂不上调试工具、注不进脚本；画面流这条路
            才让「注入到页面的调试控制台出现在面板里」成立（见 panel-browser-live）。
          */}
            {desktopShell ? (
              <div
                ref={embedSlotRef}
                data-role="native-browser-slot"
                className="absolute top-0 left-0"
                style={{
                  width: viewportWidth > 0 ? `${viewportWidth}px` : "100%",
                  height: viewportHeight > 0 ? `${viewportHeight}px` : "100%",
                }}
              />
            ) : (
              <div
                data-role="live-browser-frame"
                className="absolute top-0 left-0"
                style={{
                  width: viewportWidth > 0 ? `${viewportWidth}px` : "100%",
                  height: viewportHeight > 0 ? `${viewportHeight}px` : "100%",
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                }}
              >
                <BrowserLiveView
                  accessToken={accessToken}
                  url={url}
                  frameWidth={viewportWidth}
                  frameHeight={viewportHeight}
                  reloadToken={reloadToken}
                  onReload={onReload}
                />
              </div>
            )}
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
                className="absolute h-3 w-3 cursor-nwse-resize border border-foreground/40 bg-background"
              />
            ) : null}
          </div>
        </div>
      ) : (
        <PanelEmptyState
          kind="browser"
          title="还没有打开页面"
          hint="在上面的地址栏输入网址回车，或在对话里点链接直接开到这里。"
        />
      )}
    </div>
  );
}

/** 视口预设（参考图：`1280 × 720` 这类设备尺寸；`适应面板` = 跟面板一样大）。 */

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
      className="w-16 border bg-transparent px-1 py-0.5 font-mono text-[11px] tabular-nums outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

/** 视口尺寸的夹取（自由尺寸的两个输入框与拖拽把手共用）。 */
function clampViewport(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 缩放预设（参考图：适应窗口 / 50% / 75% / 100%）。`scale: null` = 适应视口。 */
const ZOOM_PRESETS = [
  { id: "fit", label: "适应窗口", scale: null },
  { id: "half", label: "50%", scale: 0.5 },
  { id: "three-quarter", label: "75%", scale: 0.75 },
  { id: "full", label: "100%", scale: 1 },
] as const;

type ZoomPresetId = (typeof ZOOM_PRESETS)[number]["id"];

/** 补全协议：裸地址（如 localhost:3000）按 http 处理；空串返回 null。 */
/**
 * 地址栏归一化（用户口径：「自动识别 https 还是 http，先请求 https，访问不到再 http」）。
 *
 * 与浏览器一致的做法：**裸主机名默认 https**；只有这些情况用 http——
 * - 用户显式写了 `http://`（尊重输入）；
 * - 本地/内网地址（`localhost` / `127.0.0.1` / `*.local` / 私有网段 / 带端口）：这些地址
 *   基本没有证书，默认 https 只会失败一次再回落，白等一个超时。
 *
 * 「https 打不开再 http」真正能可靠检测的是 **CDP 那条路**（受控浏览器导航失败有明确错误），
 * 已在服务端 `navigate` 里实现回落；iframe 那条路拿不到可靠的失败信号（被 X-Frame-Options
 * 拦下也会触发 load 事件），故只做**一次**默认选择，不假装能回退。
 */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const scheme = looksLocal(trimmed) ? "http" : "https";
  return `${scheme}://${trimmed}`;
}

/** 本地/内网地址判定（含带端口写法）：这些默认走 http。 */
export function looksLocal(value: string): boolean {
  const host = value.split("/")[0]?.split(":")[0]?.toLowerCase() ?? "";
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    // 回环 / 私有网段（10.0.0.0/8、172.16/12、192.168/16）
    return (
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  }
  return false;
}
