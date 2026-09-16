/**
 * 工作台三栏（左栏 / 对话列 / 右栏面板）的宽度口径。
 *
 * **为什么要有这个模块**：面板宽度此前写死 280–720，与视口、左栏状态都无关——小窗口下拖到上限
 * 会把中间的对话列挤到几百像素，composer 那排控件（权限 / 模式 / 模型 / 思考强度）互相压扁。
 * 现在口径收在一处：**中间对话列恒有最小可用宽度**，面板上限由「视口 − 左栏 − 最小对话列」现算；
 * 拖到上限还继续往里拖时，**左栏自动收成图标栏**腾地方（用户口径：「再往左边拉侧边栏自动收起来」）。
 *
 * 窄列下 composer 收成图标是**另一条口径**（CSS 容器查询，见 composer-compact-select.tsx）：
 * 容器查询在排版时算，不依赖 JS 事件，内嵌环境拖窄窗口时也生效。
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
