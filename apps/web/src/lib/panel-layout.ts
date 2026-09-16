/**
 * 工作台三栏（左栏 / 对话列 / 右栏面板）的宽度口径。
 *
 * **为什么要有这个模块**：面板宽度此前写死 280–720，与视口、左栏状态都无关——小窗口下拖到上限
 * 会把中间的对话列挤到几百像素，composer 那排控件（权限 / 模式 / 模型 / 思考强度）互相压扁。
 * 现在口径收在一处：**中间对话列恒有最小可用宽度**，面板上限由「视口 − 左栏 − 最小对话列」现算；
 * 拖到上限还继续往里拖时，**左栏自动收成图标栏**腾地方（用户口径：「再往左边拉侧边栏自动收起来」）。
 * 对话列再窄下去（小窗口 / 面板开得很大）时，composer 的权限与思考强度收成图标。
 */

/** 左栏收起态（图标栏，`w-12`）的占宽。 */
export const SIDEBAR_RAIL_WIDTH = 48;
/** 左栏自身的宽度边界（可拖范围，与工作台里的持久化口径一致）。 */
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 420;
/** 中间对话列的最小可用宽度：低于它转录与 composer 都不好用，宁可让左栏让位。 */
export const MIN_CONVERSATION_WIDTH = 420;
/** 面板宽度边界。上限取「够大」而不是「够用」——能不能真到这个宽由视口决定。 */
export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 900;
export const DEFAULT_PANEL_WIDTH = 360;
/** 面板宽度的持久化键（宽度是用户偏好，刷新后保持）。 */
export const PANEL_WIDTH_KEY = "workbench:panel-width";
/** 对话列窄于此宽度时，composer 的权限 / 思考强度收成图标。 */
export const COMPACT_COMPOSER_WIDTH = 620;

export interface PanelWidthLimits {
  min: number;
  max: number;
}

export interface PanelWidthInput {
  /** 视口宽度。未知（SSR / 首次渲染）传 0，此时不施加动态上限。 */
  windowWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

/** 面板能有多宽：先扣掉左栏，再给中间的对话列留够最小宽度。 */
export function panelWidthLimits(input: PanelWidthInput): PanelWidthLimits {
  if (!(input.windowWidth > 0)) {
    return { min: MIN_PANEL_WIDTH, max: MAX_PANEL_WIDTH };
  }
  const sidebar = input.sidebarCollapsed
    ? SIDEBAR_RAIL_WIDTH
    : input.sidebarWidth;
  const room = input.windowWidth - sidebar - MIN_CONVERSATION_WIDTH;
  return {
    min: MIN_PANEL_WIDTH,
    max: Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, room)),
  };
}

export function clampPanelWidth(
  width: number,
  limits: PanelWidthLimits,
): number {
  return Math.min(limits.max, Math.max(limits.min, width));
}

/**
 * 拖到上限还要往里拖时，是否该把左栏收起来腾地方。
 *
 * 两个条件缺一不可：**左栏确实能腾出更多空间**（收起来后上限变大），且**这次拖拽已经越过当前上限**
 * （没越过就不该动左栏——用户只是想把面板拉大一点，不该顺手把左栏收走）。
 */
export function shouldAutoCollapseSidebar(input: {
  windowWidth: number;
  sidebarWidth: number;
  nextPanelWidth: number;
}): boolean {
  const expanded = panelWidthLimits({
    windowWidth: input.windowWidth,
    sidebarWidth: input.sidebarWidth,
    sidebarCollapsed: false,
  });
  if (input.nextPanelWidth <= expanded.max) return false;
  const collapsed = panelWidthLimits({
    windowWidth: input.windowWidth,
    sidebarWidth: input.sidebarWidth,
    sidebarCollapsed: true,
  });
  return collapsed.max > expanded.max;
}

/**
 * 中间对话列的宽度：视口减去左栏与右栏面板。
 *
 * 为什么用算的而不是量 DOM：三栏都是固定/受控宽度（左栏 fixed、面板受控、main 是剩下的），
 * 算出来与量出来是同一个数（实测 1716−256−720 = 740 = 量到的 740）；而算的版本只依赖 React
 * state——不依赖 ResizeObserver 回调是否送达（内嵌/离屏环境可能不派发），窄列判定因此是确定的。
 */
export function conversationColumnWidth(input: {
  windowWidth: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** 面板实际占宽（没开或没渲染时为 0）。 */
  panelWidth: number;
}): number {
  const sidebar = input.sidebarCollapsed
    ? SIDEBAR_RAIL_WIDTH
    : input.sidebarWidth;
  return Math.max(0, input.windowWidth - sidebar - input.panelWidth);
}

/** 对话列窄到控件排不下时收成图标（宽度未知＝还没量到，保持完整形态）。 */
export function isCompactComposer(columnWidth: number | null): boolean {
  return columnWidth !== null && columnWidth < COMPACT_COMPOSER_WIDTH;
}
