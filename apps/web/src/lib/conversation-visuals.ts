"use client";

/**
 * 「对话流」显示偏好：AI 在对话流里渲染可视化组件（` ```mermaid ` / ` ```viz `）的开关。
 *
 * 为什么是**本机偏好**而不是服务端设置：它只决定「要不要把块画成图」——关掉时块原样
 * 以代码显示，模型侧能力与提示段不受影响（不做两套真相，也不为显示偏好加一次迁移）。
 * 默认**开**。
 */

const STORAGE_KEY = "kenfutwork.conversationVisuals";

export function isConversationVisualsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    // 隐私模式/存储不可用：按默认开处理（不因为读不到偏好就把功能关掉）
    return true;
  }
}

export function setConversationVisualsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // 存不进去就只在本次会话生效（不抛错打断设置页）
  }
}
