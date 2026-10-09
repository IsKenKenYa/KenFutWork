"use client";

import type { PluginMarketEntry } from "@kenfutwork/shared";
import { PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import { bearerHeaders, serverFetch } from "@/lib/local-access";

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

export interface PluginPanelEntry {
  id: string;
  pluginId: string;
  title: string;
  slot: string;
  url: string;
  /** 入口图标（相对插件根的资源路径）；null 用宿主通用图标。 */
  icon: string | null;
}

/** 取「某槽位」的插件面板入口；本机Cookie授权。 */
export function usePluginPanels(
  accessToken: string | null,
  slot: string,
): { panels: PluginPanelEntry[]; refresh: () => void } {
  const [panels, setPanels] = useState<PluginPanelEntry[]>([]);

  const refresh = useCallback(() => {
    serverFetch(`${getServerBaseUrl()}/api/plugins`, {
      headers: bearerHeaders(accessToken),
    })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ plugins: PluginMarketEntry[] }>)
          : { plugins: [] },
      )
      .then((data) => {
        setPanels(
          data.plugins
            .filter((plugin) => plugin.installed && plugin.enabled)
            .flatMap((plugin) =>
              (plugin.ui ?? [])
                .filter((entry) => (entry.slot ?? "sidebar") === slot)
                .map((entry) => ({
                  id: `${plugin.id}:${entry.id}`,
                  pluginId: plugin.id,
                  title: entry.title,
                  slot: entry.slot ?? "sidebar",
                  url: entry.url,
                  icon: entry.icon ?? null,
                })),
            ),
        );
      })
      .catch(() => setPanels([]));
  }, [accessToken, slot]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { panels, refresh };
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

export function PluginPanelOverlay({
  panel,
  onClose,
}: {
  panel: PluginPanelEntry | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={panel !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="flex h-[80vh] max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        aria-describedby={undefined}
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 border-b px-5 py-3 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <PluginIcon
              icon={panel?.icon ?? null}
              {...(panel ? { pluginId: panel.pluginId } : {})}
            />
            {panel?.title ?? "插件面板"}
          </DialogTitle>
        </DialogHeader>
        {panel ? (
          <iframe
            title={panel.title}
            src={resolvePanelUrl(panel.url, panel.pluginId)}
            className="min-h-0 flex-1 border-0"
          />
        ) : null}
      </DialogContent>
    </Dialog>
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
}: {
  accessToken: string | null;
  slot: string;
  renderButton: (panel: PluginPanelEntry, open: () => void) => React.ReactNode;
  emptyLabel?: string | undefined;
}) {
  const { panels } = usePluginPanels(accessToken, slot);
  const [active, setActive] = useState<PluginPanelEntry | null>(null);

  return (
    <>
      {panels.length === 0 && emptyLabel ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : null}
      {panels.map((panel) => renderButton(panel, () => setActive(panel)))}
      <PluginPanelOverlay panel={active} onClose={() => setActive(null)} />
    </>
  );
}
