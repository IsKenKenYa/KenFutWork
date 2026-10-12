/**
 * Flow 主区共享状态（壳侧栏导航 ↔ 主区内容面）。
 *
 * 融合后 flow 的导航在壳侧栏（工作流/插件/任务中心/引擎），内容面在主区
 * FlowSurface——两者都要读写「当前子视图」并要能驱动 iframe 内的 flow 路由。
 * code-ui 是单例应用，模块级存储即真相源（与 designProjects 同一路数）。
 */
export type FlowSurfaceView = "canvas" | "engine";

let view: FlowSurfaceView = "canvas";
const listeners = new Set<() => void>();
/** 宿主 → flow 的站内导航把手（仅在匹配 iframe 握手就绪后注册）。 */
let navigateToFlow: ((path: string) => void) | null = null;

export function subscribeFlowSurface(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFlowSurfaceView(): FlowSurfaceView {
  return view;
}

export function setFlowSurfaceView(next: FlowSurfaceView): void {
  if (view === next) return;
  view = next;
  for (const listener of listeners) listener();
}

export function getFlowNavigationReady(): boolean {
  return navigateToFlow !== null;
}

/** 侧栏导航项：回画布子视图并在 iframe 就绪时驱动站内路由。 */
export function navigateFlowSurface(path: string): void {
  setFlowSurfaceView("canvas");
  navigateToFlow?.(path);
}

export function registerFlowNavigate(
  navigate: ((path: string) => void) | null,
): void {
  if (navigateToFlow === navigate) return;
  navigateToFlow = navigate;
  for (const listener of listeners) listener();
}
