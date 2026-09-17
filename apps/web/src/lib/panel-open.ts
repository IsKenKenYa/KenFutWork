import type { PanelViewKind } from "./panel-tabs";

/**
 * 「在右栏打开某个视图」的请求通道（与 `browser-panel.ts` 的 URL 通道同构）。
 *
 * 为什么需要：设置里「子智能体」那一页要能直接跳到右栏的「子智能体」目录，但设置模态
 * 与右栏面板相隔好几层组件——为一次点击把回调一路透传下去不划算。这里用模块级订阅表：
 * 有订阅者（工作台面板已挂载）时转交面板并展开；没有订阅者时**返回 false**，
 * 调用方据此如实说明（不假装打开了）。
 */

const listeners = new Set<(kind: PanelViewKind) => void>();

/** 请求打开右栏视图；返回是否有人接单。 */
export function requestPanelView(kind: PanelViewKind): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) {
    listener(kind);
  }
  return true;
}

/** 订阅（返回退订函数）。 */
export function onPanelViewRequest(
  listener: (kind: PanelViewKind) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
