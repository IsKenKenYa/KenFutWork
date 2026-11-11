"use client";

import {
  type PluginMarketEntry,
  type PluginPanelEntry,
  projectPluginPanels,
} from "@kenfutwork/shared";
import { PanelsTopLeft, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as XLSX from "xlsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isDesktopShell } from "@/lib/desktop-embed";
import { openExternal } from "@/lib/desktop-system";
import { getServerBaseUrl } from "@/lib/env";
import { bearerHeaders, serverFetch } from "@/lib/local-access";

export type { PluginPanelEntry } from "@kenfutwork/shared";
export const PLUGIN_INVENTORY_CHANGED_EVENT =
  "kenfutwork:plugin-inventory-changed";

/**
 * 插件 UI 面板（能力 `ui`）的**共享前端**：入口按钮 + 面板弹层。
 *
 * 一个插件面板 = {id, title, slot, url}；`slot` 决定它出现在哪：
 * - `sidebar`      工作台左侧栏
 * - `conversation` 对话界面（Code 的工作台对话 / Design 的画布内对话面板）
 * - `canvas`       画布页顶部栏
 * - `settings`     设置弹窗的「插件面板」页
 *
 * 四处共用这一套组件与同一个数据源（`GET /api/plugins` 里已安装且启用插件的 `ui`），
 * 避免每处各写一遍取数 + iframe 逻辑。
 */

/** 取「某槽位」的插件面板入口；本机Cookie授权。 */
export function usePluginPanels(
  accessToken: string | null,
  slot: string,
  mode?: "code" | "design" | "flow",
) {
  const [panels, setPanels] = useState<PluginPanelEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await serverFetch(`${getServerBaseUrl()}/api/plugins`, {
        headers: bearerHeaders(accessToken),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.message ?? "插件入口读取失败");
      const next = projectPluginPanels(
        (data as { plugins: PluginMarketEntry[] }).plugins,
        slot,
        mode,
      );
      if (current !== generation.current) return null;
      setPanels(next);
      setError(null);
      return next;
    } catch (cause) {
      if (current !== generation.current) return null;
      setPanels([]);
      setError(cause instanceof Error ? cause.message : "插件入口读取失败");
      return null;
    }
  }, [accessToken, slot, mode]);

  useEffect(() => {
    const update = () => {
      void refresh();
    };
    update();
    window.addEventListener(PLUGIN_INVENTORY_CHANGED_EVENT, update);
    window.addEventListener("focus", update);
    return () => {
      generation.current++;
      window.removeEventListener(PLUGIN_INVENTORY_CHANGED_EVENT, update);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);

  return { panels, refresh, error };
}

/**
 * 面板 URL 解析：
 * - `http(s)://…`：外部地址，原样；
 * - `/…`：本站绝对路径（例如 `/api/plugins/<id>/assets/x.html`）；
 * - 其它（`assets/x.html`、`panel`）：**相对插件**——补成 `/api/plugins/<pluginId>/<url>`，
 *   这样清单里不必写死安装后的插件 id（id 随来源不同：`local__…` / `owner__repo`）。
 */
export function resolvePanelUrl(url: string, pluginId?: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${getServerBaseUrl()}${url}`;
  const base = getServerBaseUrl();
  return pluginId
    ? `${base}/api/plugins/${encodeURIComponent(pluginId)}/${url}`
    : `${base}/${url}`;
}

/**
 * 插件入口图标：**单色渲染**（CSS mask + `bg-current`），跟随所在行/标题的文字色，
 * 与宿主自己的线条图标同一套视觉语言（彩色贴图塞进菜单行会格格不入）。
 *
 * **图标必须先经带凭据的 fetch 取回再喂 mask**：CSS `mask-image: url()` 的跨源请求
 * 默认不带凭据（同源代理消失后页面与 API 分属 3300/3301 两个源），直接引用资源 URL
 * 会 401、mask 空白——表现为「插件入口的 logo 不见了」（resource timing 实测：
 * `initiatorType: css` → 401，带 credentials 的 fetch → 200）。blob URL 与页面同源，
 * mask 可用；结果按 URL 缓存，失败落 fallback。
 *
 * 槽位与图标分开：`slotClass` 固定占位（保证文字左对齐不被图标大小挤动），
 * `iconClass` 决定图标本体大小（窄字形/空心描边可以放大或缩小一档做视觉配重）。
 */
const iconObjectUrlCache = new Map<string, Promise<string | null>>();

function loadIconObjectUrl(url: string): Promise<string | null> {
  const cached = iconObjectUrlCache.get(url);
  if (cached) return cached;
  const pending = fetch(url, { credentials: "include" })
    .then((response) => (response.ok ? response.blob() : null))
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null);
  iconObjectUrlCache.set(url, pending);
  return pending;
}

export function PluginIcon({
  icon,
  pluginId,
  slotClass = "h-4 w-4",
  iconClass = "h-4 w-4",
  fallback,
}: {
  icon: string | null;
  pluginId?: string;
  slotClass?: string;
  iconClass?: string;
  /** 没有插件图标时的占位（缺省是宿主通用图标） */
  fallback?: React.ReactNode;
}) {
  const url = icon ? resolvePanelUrl(icon, pluginId) : null;
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [iconFailed, setIconFailed] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void loadIconObjectUrl(url).then((objectUrl) => {
      if (!alive) return;
      if (objectUrl) setMaskUrl(objectUrl);
      else setIconFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return (
    <span
      className={`flex shrink-0 items-center justify-center ${slotClass}`}
      aria-hidden="true"
    >
      {url ? (
        maskUrl ? (
          <span
            className={`${iconClass} bg-current`}
            style={{
              maskImage: `url(${maskUrl})`,
              maskSize: "contain",
              maskRepeat: "no-repeat",
              maskPosition: "center",
              WebkitMaskImage: `url(${maskUrl})`,
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
            }}
          />
        ) : iconFailed ? (
          (fallback ?? <PanelsTopLeft className={iconClass} />)
        ) : (
          // 加载中：空占位（slotClass 已撑住布局，不闪 fallback）
          <span className={iconClass} />
        )
      ) : (
        (fallback ?? <PanelsTopLeft className={iconClass} />)
      )}
    </span>
  );
}

/**
 * 插件面板里的 `target="_blank"` 外链（如 HA 的 OAuth 授权页）：
 * 同源面板可直接在 iframe 文档上拦截；桌面壳没有新窗口，交给系统浏览器，
 * Web 形态开新标签。相对链接与应用内导航不动。重复安装安全（按文档标记）。
 */
export function installPanelExternalLinks(
  frame: HTMLIFrameElement,
  open: (url: string) => void = (url) => {
    if (isDesktopShell()) void openExternal(url);
    else window.open(url, "_blank", "noopener");
  },
): void {
  let doc: Document | null = null;
  try {
    doc = frame.contentDocument;
  } catch {
    return;
  }
  if (!doc || doc.documentElement.dataset.kfwExternalLinks === "1") return;
  doc.documentElement.dataset.kfwExternalLinks = "1";
  doc.addEventListener(
    "click",
    (event) => {
      const anchor = (event.target as Element | null)?.closest?.(
        "a",
      ) as HTMLAnchorElement | null;
      const href = anchor?.getAttribute("href") ?? "";
      if (anchor?.target !== "_blank" || !/^https?:\/\//i.test(href)) return;
      event.preventDefault();
      open(href);
    },
    true,
  );
}

export function PluginPanelOverlay({
  panel,
  onClose,
  active = true,
}: {
  panel: PluginPanelEntry | null;
  onClose: () => void;
  active?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** 标题栏 chrome 态：normal 常规 / max 全屏。按钮同一条垂直中线、
   *  彼此只隔 4px（关闭 right-2 / 最大化 right-10 / 配置 right-18）。 */
  const [chrome, setChrome] = useState<"normal" | "max">("normal");
  const centeredBtn =
    "absolute top-1/2 -translate-y-1/2 inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] border border-transparent text-foreground transition-colors hover:bg-muted hover:text-foreground";
  const icon = "size-4";
  /** lucide 的 × 只占 viewBox 的 12/24（方形占 18/24）：同 size-4 时墨迹只有 8px，
   *  看起来明显偏小。放大到 22px（墨迹 11px）+ 1.1 描边（视觉 1px），与方形墨迹 12px 配平。 */
  const closeIcon = "size-[22px]";
  /**
   * 面板请求宿主预览文件。正文由面板用自己的接口取到后一并带来，
   * 宿主不自己读盘——路径授权仍只在服务端 `/api/knowledge/read` 一处。
   */
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
    path: string;
  } | null>(null);
  useEffect(() => {
    if (!active) return;
    const receive = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: unknown;
        name?: unknown;
        content?: unknown;
        path?: unknown;
      } | null;
      if (!data || data.type !== "kenfutwork:knowledge-preview") return;
      if (typeof data.content !== "string") return;
      setPreview({
        name: typeof data.name === "string" ? data.name : "预览",
        content: data.content,
        path: typeof data.path === "string" ? data.path : "",
      });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [active]);
  if (!panel) return null;
  return (
    <>
    <Dialog
      open={active && panel !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        portalProps={{ keepMounted: true }}
        overlayProps={{ hidden: !active }}
        hidden={!active}
        inert={!active}
        aria-hidden={!active}
        // 默认关闭钮是 top-2 固定像素、与自绘三钮重复，关掉
        showCloseButton={false}
        // 只淡入淡出：默认入场带 slide-in 8px + zoom 95%，面板边缘会「跳」一下
        style={
          {
            "--tw-enter-translate-y": "0px",
            "--tw-enter-scale": "1",
            "--tw-exit-translate-y": "0px",
            "--tw-exit-scale": "1",
          } as React.CSSProperties
        }
        className={`flex flex-col gap-0 overflow-hidden border-b-0 p-0 ${
          chrome === "max"
            ? "inset-0 h-[100vh] max-h-[100vh] w-auto translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "h-[80vh] max-h-[80vh] sm:max-w-4xl"
        }`}
        aria-describedby={undefined}
      >
        <DialogHeader className="relative flex-row items-center justify-between space-y-0 border-b px-5 py-3 pr-36">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            {/* 中文的墨迹中心比图标盒中心高约 1px（字体 ascent 偏大），
                给图标一像素光学上移，标题字与图标才看着同一条中线 */}
            <PluginIcon
              icon={panel?.icon ?? null}
              slotClass="h-4 w-4 -translate-y-px"
              {...(panel ? { pluginId: panel.pluginId } : {})}
            />
            {panel?.title ?? "插件面板"}
          </DialogTitle>
          {panel?.configurable ? (
            <button
              type="button"
              className="absolute right-18 top-1/2 -translate-y-1/2 rounded-md border px-2.5 py-1 text-sm text-foreground hover:bg-accent"
              onClick={() => {
                frameRef.current?.contentWindow?.postMessage(
                  { type: "kenfutwork:plugin-panel-toggle-config" },
                  "*",
                );
              }}
            >
              配置
            </button>
          ) : null}
          <button
            type="button"
            aria-label="最大化"
            title={chrome === "max" ? "还原" : "最大化"}
            className={`${centeredBtn} right-10`}
            onClick={() => setChrome(chrome === "max" ? "normal" : "max")}
          >
            <Square className={icon} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <DialogClose
            className={`${centeredBtn} right-2`}
            aria-label="关闭"
            title="关闭"
          >
            <X className={closeIcon} strokeWidth={1.1} aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        {panel ? (
          <iframe
            ref={frameRef}
            title={panel.title}
            src={resolvePanelUrl(panel.url, panel.pluginId)}
            className="min-h-0 flex-1 border-0"
            onLoad={(event) => installPanelExternalLinks(event.currentTarget)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
    <KnowledgePreviewDialog target={preview} onClose={() => setPreview(null)} />
    </>
  );
}

/**
 * 面板（沙箱 iframe）请求的只读预览。正文由面板用自己的接口取到后带过来，
 * 宿主不自己读盘；markdown 走与壳内同一套库（react-markdown + GFM）。
 */
function KnowledgePreviewDialog({
  target,
  onClose,
}: {
  target: { name: string; content: string; path: string } | null;
  onClose: () => void;
}) {
  /** 与面板同款窗框：normal 常规 / max 全屏；窗控位置与尺寸同面板标题栏。 */
  const [chrome, setChrome] = useState<"normal" | "max">("normal");
  const centeredBtn =
    "absolute top-1/2 -translate-y-1/2 inline-flex size-7 items-center justify-center rounded-[min(var(--radius-md),12px)] border border-transparent text-foreground transition-colors hover:bg-muted hover:text-foreground";
  const name = target?.name ?? "";
  const isMarkdown = /\.(md|mdx|markdown)$/iu.test(name);
  const isImage = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/iu.test(name);
  const isPdf = /\.pdf$/iu.test(name);
  const isSheet = /\.(xlsx|xls|csv)$/iu.test(name);
  const isDocx = /\.docx$/iu.test(name);
  const isPptx = /\.(pptx|ppt)$/iu.test(name);
  const fileUrl =
    target && target.path
      ? `/api/knowledge/file?path=${encodeURIComponent(target.path)}`
      : "";
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        portalProps={{ keepMounted: true }}
        showCloseButton={false}
        overlayProps={{ className: "hidden" }}
        // 与知识库面板同款窗框：同一套标题栏、同一套窗控位置与尺寸
        className={`flex flex-col gap-0 overflow-hidden border-b-0 p-0 ${
          chrome === "max"
            ? "inset-0 h-[100vh] max-h-[100vh] w-auto translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "h-[80vh] max-h-[80vh] sm:max-w-4xl"
        }`}
        aria-describedby={undefined}
      >
        <DialogHeader className="relative flex-row items-center justify-between space-y-0 border-b px-5 py-3 pr-36">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-base font-medium">
            <span className="min-w-0 truncate">{target?.name ?? "预览"}</span>
          </DialogTitle>
          <button
            type="button"
            aria-label="最大化"
            title={chrome === "max" ? "还原" : "最大化"}
            className={`${centeredBtn} right-10`}
            onClick={() => setChrome(chrome === "max" ? "normal" : "max")}
          >
            <Square className="size-4" strokeWidth={1.5} aria-hidden="true" />
          </button>
          <DialogClose
            className={`${centeredBtn} right-2`}
            aria-label="关闭"
            title="关闭"
          >
            <X className="size-[22px]" strokeWidth={1.1} aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-muted/30">
          {isImage && fileUrl ? (
            <div className="flex h-full items-center justify-center p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={fileUrl}
                alt={name}
                className="max-h-full max-w-full rounded-md object-contain shadow-sm"
              />
            </div>
          ) : isPdf && fileUrl ? (
            <iframe
              src={fileUrl}
              title={name}
              className="h-full w-full border-0 bg-white"
            />
          ) : isSheet && fileUrl ? (
            <SheetTable url={fileUrl} />
          ) : isDocx && fileUrl ? (
            <DocxView url={fileUrl} />
          ) : isPptx && fileUrl ? (
            <PptxView url={fileUrl} />
          ) : isMarkdown ? (
            <div className="space-y-3 px-5 py-4 text-sm leading-6 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_img]:max-w-full [&_img]:rounded-md [&_li]:ml-5 [&_li]:list-disc [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // md 里的图片是相对知识库目录的路径：改写成字节路由，否则断链。
                  img: ({ src, alt }) => (
                    <img
                      src={resolveAssetUrl(
                        typeof src === "string" ? src : "",
                        target?.path ?? "",
                      )}
                      alt={alt ?? ""}
                    />
                  ),
                }}
              >
                {target?.content ?? ""}
              </Markdown>
            </div>
          ) : (
            // 支持范围只到 文档/表格/演示/图片；代码等其它类型不提供预览
            <p className="px-5 py-4 text-sm text-muted-foreground">
              该类型不支持预览
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** md 里的相对图片按所在目录解析成字节路由；绝对 URL 原样返回。 */
function resolveAssetUrl(src: string, filePath: string): string {
  if (!src) return src;
  if (/^(?:https?:|data:|blob:)/iu.test(src)) return src;
  // markdown 渲染器会先把 URL 编码一次（封面.png → %E5%B0%81…），
  // 这里先还原，否则再 encode 一遍会变成 %25E5… 导致服务端找不到文件。
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // 非法百分号序列就按原样用
  }
  const base = filePath.replace(/[\\/][^\\/]*$/u, "");
  const target =
    decoded.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(decoded)
      ? decoded
      : `${base}/${decoded.replace(/^\.\//u, "")}`;
  return `/api/knowledge/file?path=${encodeURIComponent(target)}`;
}

/** pptx：pptx-preview 纯前端渲染（每页按幻灯片画布绘制）。 */
function PptxView({ url }: { url: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    host.innerHTML = "";
    setError(null);
    (async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const mod = (await import("pptx-preview")) as unknown as {
        init: (
          el: HTMLElement,
          options: { width: number; height: number },
        ) => { preview: (data: ArrayBuffer) => Promise<void> | void };
      };
      if (cancelled) return;
      // 铺满弹窗宽度：不设上限、不吃额外边距（外层已有 px-5）
      const width = Math.max(320, host.clientWidth || 880);
      const viewer = mod.init(host, {
        width,
        height: Math.round(width * 0.75),
      });
      await viewer.preview(buf);
      // 库把画布背景写死成黑色、高度按 16:9 写死：清掉它们，
      // 让幻灯片按自身比例撑开，避免黑边与内层滚动条。
      const wrapper = host.querySelector<HTMLElement>(".pptx-preview-wrapper");
      if (wrapper) {
        wrapper.style.background = "transparent";
        wrapper.style.height = "auto";
        wrapper.style.overflow = "visible";
        wrapper.style.width = "100%";
      }
    })().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "解析失败");
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className="px-5 py-4">
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <div ref={hostRef} className="space-y-4" />
      )}
    </div>
  );
}

/**
 * docx：mammoth 转 HTML（保留标题/列表/表格，图片转 data URI）。
 * mammoth 的 browser 字段指向纯浏览器实现，不会把 Node 的 fs 带进来。
 */
function DocxView({ url }: { url: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    (async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const mod = (await import("mammoth")) as unknown as {
        convertToHtml?: (o: {
          arrayBuffer: ArrayBuffer;
        }) => Promise<{ value: string }>;
        default?: {
          convertToHtml: (o: {
            arrayBuffer: ArrayBuffer;
          }) => Promise<{ value: string }>;
        };
      };
      const convert = mod.convertToHtml ?? mod.default?.convertToHtml;
      if (!convert) throw new Error("docx 解析器不可用");
      const out = await convert({ arrayBuffer: buf });
      // 只做展示：去掉脚本与内联事件属性
      return out.value
        .replace(/<script[\s\S]*?<\/script>/giu, "")
        .replace(/\son[a-z]+="[^"]*"/giu, "");
    })()
      .then((value) => {
        if (!cancelled) setHtml(value);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "解析失败");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (error)
    return <p className="px-5 py-4 text-sm text-destructive">{error}</p>;
  if (html === null)
    return <p className="px-5 py-4 text-sm text-muted-foreground">解析中…</p>;
  return (
    <div
      className="px-5 py-4 text-sm leading-6 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:font-medium [&_img]:max-w-full [&_li]:ml-5 [&_li]:list-disc [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1"
      // mammoth 生成的 HTML 已按文档结构转义，脚本与内联事件在上面被剔除
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** xlsx/xls/csv：SheetJS 解析成表格渲染（首行作表头）。 */
function SheetTable({ url }: { url: string }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetch(url, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`读取失败 HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const wb = XLSX.read(buf, { type: "array" });
        const first = wb.SheetNames[0];
        const sheet = first === undefined ? undefined : wb.Sheets[first];
        if (!sheet) throw new Error("空工作簿");
        const data = XLSX.utils.sheet_to_json<string[]>(sheet, {
          header: 1,
          defval: "",
          raw: false,
        });
        setRows(data.map((r) => r.map((c) => String(c ?? ""))));
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "解析失败");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (error)
    return <p className="px-5 py-4 text-sm text-destructive">{error}</p>;
  if (!rows)
    return <p className="px-5 py-4 text-sm text-muted-foreground">解析中…</p>;
  const [head, ...body] = rows;
  return (
    <div className="p-4">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {(head ?? []).map((cell, i) => (
              <th
                key={i}
                className="border border-border bg-muted px-2 py-1 text-left font-medium"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className="border border-border px-2 py-1">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 槽位入口按钮组：渲染该槽位的全部面板按钮，并内置弹层状态。
 * `renderButton` 让调用方决定外观（侧栏行 / 标题栏小按钮 / 设置里的卡片）。
 *
 * `emptyLabel` 只有「列表页」才该传（设置 → 插件面板）：入口点空着就该整个不出现
 * （见 AGENTS.md「Flow 模式」的不摆空壳），但**列表页空着必须说出来**——否则整页
 * 只剩一个关闭按钮，用户看到的是白板而不是「这里没有东西」。
 */
export function PluginPanelButtons({
  accessToken,
  slot,
  renderButton,
  emptyLabel,
  mode,
  workspaceActive = true,
}: {
  accessToken: string | null;
  slot: string;
  renderButton: (panel: PluginPanelEntry, open: () => void) => React.ReactNode;
  emptyLabel?: string | undefined;
  mode?: "code" | "design" | "flow";
  workspaceActive?: boolean;
}) {
  const { panels, error } = usePluginPanels(accessToken, slot, mode);
  const [active, setActive] = useState<PluginPanelEntry | null>(null);
  useEffect(() => {
    setActive((current) =>
      current
        ? (panels.find((panel) => panel.id === current.id) ?? null)
        : null,
    );
  }, [panels]);

  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {!error && panels.length === 0 && emptyLabel ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : null}
      {panels.map((panel) => renderButton(panel, () => setActive(panel)))}
      <PluginPanelOverlay
        panel={active}
        active={workspaceActive}
        onClose={() => setActive(null)}
      />
    </>
  );
}
