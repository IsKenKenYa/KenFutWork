/**
 * 「在右栏浏览器里打开这个 URL」的极简请求通道。
 *
 * 为什么需要它：转录里的链接由 `MarkdownRenderer` 渲染，而右栏面板挂在工作台上——
 * 两者相隔好几层，不值得为了一个点击把回调一路透传下去（Design 的画布助手也用同一个
 * 渲染器，那条路径上根本没有面板）。这里用一个模块级的订阅表：有订阅者（工作台面板
 * 已挂载）时链接点击转交面板；没有订阅者时**什么都不做**，让链接保持默认行为
 * （新标签打开），绝不把点击吞掉。
 */

const listeners = new Set<(url: string) => void>();

/** 是否有面板在监听（没有就别拦截点击）。 */
export function canOpenInBrowserPanel(): boolean {
  return listeners.size > 0;
}

/** 请求在右栏浏览器里打开；返回是否有人接单。 */
export function requestBrowserOpen(url: string): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) {
    listener(url);
  }
  return true;
}

/** 订阅（返回退订函数）。 */
export function onBrowserOpen(listener: (url: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
