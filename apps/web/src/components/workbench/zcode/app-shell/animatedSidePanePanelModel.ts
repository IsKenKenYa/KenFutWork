const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

/** 判定「拖到上限」的百分比容差（库在边界附近会给小数抖动）。 */
const PANEL_MAX_REACHED_EPSILON = 0.5;

/** 解析面板布局里的百分比字符串（"65%" → 65）；非百分比（px）返回 null。 */
export function parsePanelMaxSizePercent(
  maxSize: string | number,
): number | null {
  if (typeof maxSize === "number") return maxSize > 0 ? maxSize : null;
  const match = /^([\d.]+)%$/.exec(maxSize.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * P2（G11）：右栏拖到宽度上限时是否通知壳层收起左侧栏腾地方。
 *
 * 旧版行为 = 面板拖到上限自动收左栏；这里只在「确实到顶」时为真，
 * 程序化展开（默认见 SIDE_PANE_DEFAULT_EXPANDED_SIZE，低于 65% 上限）与普通拖拽都不触发。
 */
export function shouldCollapseSidebarAtPanelMax({
  panelSizePercent,
  maxSizePercent,
}: {
  panelSizePercent: number;
  maxSizePercent: number;
}): boolean {
  if (!Number.isFinite(panelSizePercent) || !Number.isFinite(maxSizePercent)) {
    return false;
  }
  return panelSizePercent >= maxSizePercent - PANEL_MAX_REACHED_EPSILON;
}

export type OpenTabLauncherItemId =
  | "selection-side-conversation"
  | "review"
  | "terminal"
  | "browser"
  | "developer-tools"
  | "open-design";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  supportsEmbeddedBrowser = true,
  openDesignEnabled = false,
}: {
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  supportsEmbeddedBrowser?: boolean;
  /**
   * OpenDesign 入口（Code 模式右侧栏的联动画布）。
   * 缺省 false：它是插件形态交付的能力，未安装插件或宿主未就绪时**不出现**入口
   * （由调用方按壳内 `useOpenDesignEntry` 的结果传入，不摆空壳）。
   */
  openDesignEnabled?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = [];

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  itemIds.push("terminal");

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  if (openDesignEnabled) {
    itemIds.push("open-design");
  }

  if (developerToolsEnabled) {
    itemIds.push("developer-tools");
  }

  return itemIds;
}

export function shouldOfferSelectionSideConversation({
  activeTaskId,
}: {
  activeTaskId: string | null;
}): boolean {
  return Boolean(activeTaskId);
}

export function resolveAnimatedSidePanePanelLayout() {
  return {
    collapsedSize: "0px",
    defaultSize: "0px",
    maxSize: "65%",
    minSize: "240px",
    useResizablePanel: true,
  };
}

export function shouldRenderPreviewPaneHeavyContent({
  isActiveTab,
  isMediaPreview = false,
  isResizeSettling = false,
  isSidePaneVisible,
  minVisibleInlineSizePx = MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  visibleInlineSizePx,
}: {
  isActiveTab: boolean;
  isMediaPreview?: boolean;
  isResizeSettling?: boolean;
  isSidePaneVisible: boolean;
  minVisibleInlineSizePx?: number;
  visibleInlineSizePx: number | null;
}) {
  if (!isSidePaneVisible || !isActiveTab) {
    return false;
  }

  if (isResizeSettling) {
    // 原生 video/audio 进入 HTML fullscreen 时会触发 resize；如果此时卸载
    // 媒体节点，浏览器会因 fullscreen 元素消失而立即退出全屏。
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
