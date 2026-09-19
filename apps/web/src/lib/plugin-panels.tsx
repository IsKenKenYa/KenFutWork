"use client";

import type { PluginMarketEntry } from "@kenfutwork/shared";
import { PanelsTopLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";

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

/** 取「某槽位」的插件面板入口；token 变化自动重取。 */
export function usePluginPanels(
  accessToken: string | null,
  slot: string,
): { panels: PluginPanelEntry[]; refresh: () => void } {
  const [panels, setPanels] = useState<PluginPanelEntry[]>([]);

  const refresh = useCallback(() => {
    if (!accessToken) return;
    fetch(`${getServerBaseUrl()}/api/plugins`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ plugins: PluginMarketEntry[] }>)
          : { plugins: [] },
      )
      .then((data) => {
        setPanels(
          data.plugins
            .filter((plugin) => plugin.installed)
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
 * 面板登录态握手的消息类型：宿主把当前 access_token 用 postMessage 递给**同源**面板页。
 *
 * 存在理由：面板是 iframe，带不上 `Authorization` 头（见 `http/plugins.ts` 的注释），
 * 于是需要登录态的插件只能把数据路由开成 `public`——等于任何能访问服务端的人都能读。
 * 握手之后插件路由可以名正言顺地要求登录，面板也能拿到 `request.workspaceId`
 * （插件存储 `ctx.storage` 需要它）。面板页侧监听见 `plugins/mihome/assets/panel.js`。
 *
 * 只递**同源**面板：外链面板（`http(s)://` 指向别的站）绝不递——那是把用户令牌交给第三方。
 */
export const PANEL_TOKEN_MESSAGE_TYPE = "kenfutwork:plugin-panel-token";

function originOf(value: string, fallback?: string): string | null {
  try {
    return new URL(value, fallback).origin;
  } catch {
    return null;
  }
}

/**
 * 面板该把令牌递给谁：返回可用的 targetOrigin；非同源（或地址不可解析）返回 null 表示不递。
 *
 * 同源口径覆盖两种部署：直连后端（base 是 `http://host:3001`）与 dev/桌面的同源代理
 * （base 是空串，面板 URL 落在页面自己的 origin 上）。
 */
export function panelTokenTarget(
  url: string,
  pluginId?: string,
): string | null {
  const pageOrigin =
    typeof window === "undefined" ? undefined : window.location.origin;
  const target = originOf(resolvePanelUrl(url, pluginId), pageOrigin);
  if (!target) return null;
  const server = originOf(getServerBaseUrl(), pageOrigin);
  if (!server) return null;
  return target === server ? target : null;
}

export function PluginPanelOverlay({
  panel,
  accessToken,
  onClose,
}: {
  panel: PluginPanelEntry | null;
  accessToken: string | null;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const targetOrigin = panel
    ? panelTokenTarget(panel.url, panel.pluginId)
    : null;

  // 两次时机都要发：面板刚加载完（load）与令牌刷新（依赖变化）。
  // 面板页可能先前没收到，或手里那份已经过期。
  const handOverToken = useCallback(() => {
    if (!targetOrigin || !accessToken) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: PANEL_TOKEN_MESSAGE_TYPE, accessToken },
      targetOrigin,
    );
  }, [targetOrigin, accessToken]);

  useEffect(() => {
    handOverToken();
  }, [handOverToken]);

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
            <PanelsTopLeft className="h-4 w-4" />
            {panel?.title ?? "插件面板"}
          </DialogTitle>
        </DialogHeader>
        {panel ? (
          <iframe
            ref={frameRef}
            title={panel.title}
            src={resolvePanelUrl(panel.url, panel.pluginId)}
            onLoad={handOverToken}
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
 */
export function PluginPanelButtons({
  accessToken,
  slot,
  renderButton,
}: {
  accessToken: string | null;
  slot: string;
  renderButton: (panel: PluginPanelEntry, open: () => void) => React.ReactNode;
}) {
  const { panels } = usePluginPanels(accessToken, slot);
  const [active, setActive] = useState<PluginPanelEntry | null>(null);

  return (
    <>
      {panels.map((panel) => renderButton(panel, () => setActive(panel)))}
      <PluginPanelOverlay
        panel={active}
        accessToken={accessToken}
        onClose={() => setActive(null)}
      />
    </>
  );
}
