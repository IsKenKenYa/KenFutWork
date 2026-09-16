"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChangesPane } from "@/components/workbench/panel-changes-view";
import { FilesPane } from "@/components/workbench/panel-files-view";
import { BrowserPane } from "@/components/workbench/panel-browser-view";
import { DiffPane, FilePane } from "@/components/workbench/panel-reading-view";
import { PanelTabStrip } from "@/components/workbench/panel-tab-strip";
import { TerminalPane } from "@/components/workbench/panel-terminal-view";
import { SubagentDirectoryView } from "@/components/workbench/subagent-directory-view";
import type { WebSocketHandle } from "@/hooks/use-websocket";
import {
  canGoBack,
  canGoForward,
  createHistory,
  currentUrl,
  goBack,
  goForward,
  openUrl,
} from "@/lib/browser-history";
import { onBrowserOpen } from "@/lib/browser-panel";
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_KEY,
  type PanelWidthLimits,
} from "@/lib/panel-layout";
import {
  closePanelTab,
  makePanelTab,
  openPanelTab,
  type PanelTab,
  type PanelView,
} from "@/lib/panel-tabs";
import type { SubagentEntry } from "@/lib/subagent-directory";

/**
 * Code 工作台的右栏停靠面板（参考图 R3-1「扩展插件-添加终端、浏览器、变更等功能」）。
 *
 * 形态是**编辑器式多标签**（用户口径：像画布右侧面板那样，每个视图/文件各开一个标签、
 * 可关、关掉后右邻接替）：标签条在 lib/panel-tabs 里有一套纯函数管顺序与身份，
 * 正文按标签类型分发给各自的视图（变更 / 文件目录 / 终端 / 浏览器 / 子智能体 / 差异 / 文件）。
 *
 * **面板关掉时仍然挂载**（`hidden`，不是卸载）：终端会话、浏览器页面、文件目录的当前位置
 * 都是「长驻视图」——每次开关都重建会把这些状态清空（用户要看的是同一个终端、同一个页面）。
 */
export function WorkbenchSidePanel({
  open,
  onClose,
  accessToken,
  canvasId,
  subagents,
  running,
  ws,
  widthLimits,
  onGrowBlocked,
  maxWidthExpression,
  onRequestOpen,
}: {
  open: boolean;
  onClose: () => void;
  accessToken: string | null;
  /** 作用域画布 = 会话自己绑定的项目主画布（与 run 同一口径）。 */
  canvasId: string | null;
  subagents: SubagentEntry[];
  running: boolean;
  /** WS 句柄：终端标签的会话就挂在这条连接上（见 hooks/use-websocket 的终端通道）。 */
  ws: WebSocketHandle;
  /** 宽度上下限（工作台按视口与左栏现算，见 lib/panel-layout）。 */
  widthLimits?: PanelWidthLimits;
  /** 拖到上限还继续往里拖：工作台据此把左栏收起来腾地方。 */
  onGrowBlocked?: () => void;
  /**
   * 面板宽度的 CSS 上限表达式（如 `calc(100vw - var(--workbench-sidebar, 256px) - 420px)`）。
   * JS 的 `widthLimits` 依赖 resize 事件，宿主不派发时会陈旧；这条由浏览器排版保证
   * 中间的对话列不被挤没（两条同一口径，见 lib/panel-layout）。
   */
  maxWidthExpression?: string;
  /** 转录里点了链接而面板收着时：请工作台把面板打开（浏览器标签已经就位）。 */
  onRequestOpen?: () => void;
}) {
  const [state, setState] = useState<{
    tabs: PanelTab[];
    activeId: string | null;
  }>(() => ({
    tabs: [makePanelTab({ kind: "changes" }, Date.now())],
    activeId: "changes",
  }));
  /** 变更清单的重读计数：暂存/撤销之后 +1（清单与差异视图都跟着刷新）。 */
  const [changesVersion, setChangesVersion] = useState(0);
  const bumpChanges = useCallback(
    () => setChangesVersion((current) => current + 1),
    [],
  );

  const openView = useCallback((view: PanelView) => {
    setState((current) =>
      openPanelTab(current.tabs, current.activeId, view, Date.now()),
    );
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((current) => closePanelTab(current.tabs, current.activeId, id));
  }, []);

  const activateTab = useCallback((id: string) => {
    setState((current) => ({ ...current, activeId: id }));
  }, []);

  /**
   * 右栏浏览器（R3-1）：**面板内历史栈**（后退/前进/刷新按参考图补齐）。
   * 不用 `iframe.contentWindow.history`——内嵌页面基本跨源，读不到它的历史（见 lib/browser-history）。
   */
  const [browserHistory, setBrowserHistory] = useState(createHistory);
  const browserUrl = currentUrl(browserHistory);
  /** 地址栏输入框（与已加载的 URL 分开，回车才加载）。 */
  const [urlDraft, setUrlDraft] = useState("");
  /** 刷新用的计数：改 key 让 iframe 真的重新加载（同 src 不会重载）。 */
  const [reloadToken, setReloadToken] = useState(0);

  /** 转录里点链接 → 打开浏览器标签并加载该 URL（见 lib/browser-panel）。 */
  const openRef = useRef(open);
  openRef.current = open;
  const requestOpenRef = useRef(onRequestOpen);
  requestOpenRef.current = onRequestOpen;
  useEffect(
    () =>
      onBrowserOpen((url) => {
        setState((current) =>
          openPanelTab(current.tabs, current.activeId, { kind: "browser" }, Date.now()),
        );
        setBrowserHistory((current) => openUrl(current, url));
        setUrlDraft(url);
        if (!openRef.current) requestOpenRef.current?.();
      }),
    [],
  );

  /** 面板宽度（可拖拽，持久化到 localStorage：宽度是用户偏好）。 */
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    const fallback =
      Number.isFinite(saved) &&
      saved >= MIN_PANEL_WIDTH &&
      saved <= MAX_PANEL_WIDTH
        ? saved
        : DEFAULT_PANEL_WIDTH;
    return widthLimits ? clampPanelWidth(fallback, widthLimits) : fallback;
  });

  /**
   * 视口变小或左栏重新展开时，把面板收回到当前上限内——中间对话列不被挤没
   * （用户口径：「保证右侧面板大小可以比较灵活调整」，但对话列要有下限）。
   */
  const limitsRef = useRef(widthLimits);
  limitsRef.current = widthLimits;
  useEffect(() => {
    if (!widthLimits) return;
    setWidth((current) => clampPanelWidth(current, widthLimits));
  }, [widthLimits]);

  /**
   * 拖左边缘调宽（参考图：左右面板都能调）。面板在右侧，故向左拖 = 变宽；
   * 松手时落 localStorage——宽度是用户偏好，刷新后保持。
   *
   * **拖过上限 = 请求腾地方**：上限是「视口 − 左栏 − 对话列最小宽度」现算的，所以继续拖只会
   * 卡住不动。此时通知工作台把左栏收成图标栏（一次拖拽只请求一次，避免来回抖动），
   * 上限随之变大、面板接着变宽。
   */
  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      let askedForRoom = false;
      const onMove = (moveEvent: MouseEvent) => {
        const desired = startWidth + (startX - moveEvent.clientX);
        const limits = limitsRef.current;
        if (!askedForRoom && limits && desired > limits.max) {
          askedForRoom = true;
          onGrowBlocked?.();
        }
        setWidth(
          clampPanelWidth(
            desired,
            limits ?? { min: MIN_PANEL_WIDTH, max: MAX_PANEL_WIDTH },
          ),
        );
      };
      const onUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        const limits = limitsRef.current;
        window.localStorage.setItem(
          PANEL_WIDTH_KEY,
          String(
            clampPanelWidth(
              startWidth + (startX - upEvent.clientX),
              limits ?? { min: MIN_PANEL_WIDTH, max: MAX_PANEL_WIDTH },
            ),
          ),
        );
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [width, onGrowBlocked],
  );

  return (
    <aside
      aria-label="工作台面板"
      hidden={!open}
      style={
        maxWidthExpression
          ? { width, minWidth: MIN_PANEL_WIDTH, maxWidth: maxWidthExpression }
          : { width }
      }
      className="relative flex shrink-0 flex-col border-l bg-card"
    >
      {/* 拖拽把手：贴面板左边缘（按住拖动改宽） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        onMouseDown={startResize}
        className="absolute top-0 -left-0.5 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/20"
      />
      <PanelTabStrip
        tabs={state.tabs}
        activeId={state.activeId}
        onActivate={activateTab}
        onCloseTab={closeTab}
        onOpenView={openView}
        onClosePanel={onClose}
      />

      {state.tabs.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
          没有打开的视图。点上面的 ＋ 打开变更、文件目录、终端或浏览器。
        </div>
      ) : (
        state.tabs.map((tab) => (
          <div
            key={tab.id}
            hidden={tab.id !== state.activeId}
            className="min-h-0 flex-1 overflow-y-auto p-3"
          >
            <PaneContent
              tab={tab}
              accessToken={accessToken}
              canvasId={canvasId}
              subagents={subagents}
              running={running}
              ws={ws}
              changesVersion={changesVersion}
              onChanged={bumpChanges}
              onOpenView={openView}
              browser={{
                url: browserUrl,
                draft: urlDraft,
                reloadToken,
                canBack: canGoBack(browserHistory),
                canForward: canGoForward(browserHistory),
                onDraftChange: setUrlDraft,
                onNavigate: (next) => {
                  setBrowserHistory((current) => openUrl(current, next));
                  setUrlDraft(next);
                },
                onBack: () => {
                  setBrowserHistory((current) => {
                    const next = goBack(current);
                    setUrlDraft(currentUrl(next));
                    return next;
                  });
                },
                onForward: () => {
                  setBrowserHistory((current) => {
                    const next = goForward(current);
                    setUrlDraft(currentUrl(next));
                    return next;
                  });
                },
                onReload: () => setReloadToken((token) => token + 1),
              }}
            />
          </div>
        ))
      )}
    </aside>
  );
}

/** 一个标签的正文（按视图类型分发；各自持有数据与动作）。 */
function PaneContent({
  tab,
  accessToken,
  canvasId,
  subagents,
  running,
  ws,
  changesVersion,
  onChanged,
  onOpenView,
  browser,
}: {
  tab: PanelTab;
  accessToken: string | null;
  canvasId: string | null;
  subagents: SubagentEntry[];
  running: boolean;
  ws: WebSocketHandle;
  changesVersion: number;
  onChanged: () => void;
  onOpenView: (view: PanelView) => void;
  browser: React.ComponentProps<typeof BrowserPane>;
}) {
  const view = tab.view;
  switch (view.kind) {
    case "changes":
      return (
        <ChangesPane
          accessToken={accessToken}
          canvasId={canvasId}
          version={changesVersion}
          onChanged={onChanged}
          onOpenDiff={(path) => onOpenView({ kind: "diff", path })}
          onOpenFile={(path) => onOpenView({ kind: "file", path })}
        />
      );
    case "files":
      return (
        <FilesPane
          accessToken={accessToken}
          canvasId={canvasId}
          onOpenFile={(path) => onOpenView({ kind: "file", path })}
        />
      );
    case "diff":
      return (
        <DiffPane
          accessToken={accessToken}
          canvasId={canvasId}
          path={view.path ?? ""}
          version={changesVersion}
          onChanged={onChanged}
          onOpenFile={(path) => onOpenView({ kind: "file", path })}
        />
      );
    case "file":
      return (
        <FilePane
          accessToken={accessToken}
          canvasId={canvasId}
          path={view.path ?? ""}
        />
      );
    case "terminal":
      return (
        <TerminalPane
          accessToken={accessToken}
          canvasId={canvasId}
          ws={ws}
        />
      );
    case "browser":
      return <BrowserPane {...browser} />;
    case "subagents":
      return subagents.length > 0 ? (
        <SubagentDirectoryView entries={subagents} running={running} />
      ) : (
        <p className="text-xs text-muted-foreground">
          这个会话还没有派过子智能体。
        </p>
      );
  }
}

export { normalizeUrl } from "@/components/workbench/panel-browser-view";
