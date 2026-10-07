/**
 * 米家面板的宿主握手判据（从 panel.js 抽出的纯函数，供单测锁行为）。
 *
 * 判据是「消息来自父窗口」而不是「同源」：宿主工作台（web）与面板页（服务端托管）
 * 在开发态（3000/3001）与自托管分离部署下本就是两个 origin，同源判据会把合法宿主
 * 的令牌全部丢掉——面板永远停在「正在获取登录态…」（2026-10-07 真机实测）。
 * 宿主 postMessage 的目标 origin 收窄到面板自身 origin（见 lib/plugin-panels.tsx），
 * 令牌不会外流；伪造父窗口者也只能拿到自己递进来的令牌。
 */
export const PANEL_TOKEN_MESSAGE_TYPE = "kenfutwork:plugin-panel-token";

/**
 * 面板 → 宿主的「就绪回执」。面板脚本可能晚于 iframe `load` 才注册好监听
 * （panel.html 用引导脚本异步加载，见其加载方式说明），宿主 onLoad 时递来的令牌
 * 会赶在监听器存在之前到达而丢失；面板注册完监听后回执这条消息，宿主据此补递一次。
 */
export const PANEL_READY_MESSAGE_TYPE = "kenfutwork:plugin-panel-ready";

/**
 * 这条 message 事件是否是宿主递来的、可接受的面板令牌。
 *
 * @param event 形如 `{ source, data }` 的 message 事件（source 为消息发送方窗口）
 * @param parentWindow 当前面板所在窗口的父窗口（浏览器里是 `window.parent`）
 * @returns 是否接受
 */
export function isHostPanelTokenMessage(event, parentWindow) {
  if (event.source !== parentWindow) return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  if (data.type !== PANEL_TOKEN_MESSAGE_TYPE) return false;
  return typeof data.accessToken === "string" && data.accessToken !== "";
}
