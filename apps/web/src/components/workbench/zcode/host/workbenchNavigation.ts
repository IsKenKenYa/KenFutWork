import { workbenchNavigationSchema } from "@kenfutwork/shared";
import type { HostWorkbenchMode, HostWorkbenchNavigation } from "@zcode/shared";

/**
 * 工作台模式导航（融合后的唯一持有处）。
 *
 * 模式不再换壳：Design/Flow 是 Code 壳内的主区视图（WorkspaceMainView），
 * 本存储只承载「当前模式」与可用模式——pills 读快照渲染 active 态，
 * open() 改写快照，App 侧的同步 effect（useWorkbenchSurfaceMode）据此切换主区视图。
 * 父窗口仍可通过 kenfutwork:workbench-navigation 推送模式（深链 / 外部导航）。
 * 原树的 interfaceMode 始终保持 coding。
 */
export function createHostWorkbenchNavigation(
  parent: Window,
  availableModes: readonly HostWorkbenchMode[],
): HostWorkbenchNavigation & { dispose: () => void } {
  let snapshot: {
    mode: HostWorkbenchMode;
    availableModes: readonly HostWorkbenchMode[];
  } = { mode: "code", availableModes };
  const listeners = new Set<() => void>();
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== window.location.origin)
      return;
    const parsed = workbenchNavigationSchema.safeParse(event.data);
    if (!parsed.success) return;
    publish({
      // 不带 mode 的推送只更新可用模式，不改动当前模式（避免把壳内已切的面弹回去）。
      mode: parsed.data.mode ?? snapshot.mode,
      availableModes: parsed.data.availableModes,
    });
  };
  window.addEventListener("message", receive);
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (mode) => {
      if (mode === snapshot.mode || !snapshot.availableModes.includes(mode))
        return;
      publish({ ...snapshot, mode });
    },
    setActiveMode: (mode) => {
      if (mode === snapshot.mode) return;
      publish({ ...snapshot, mode });
    },
    dispose: () => {
      window.removeEventListener("message", receive);
      listeners.clear();
    },
  };
}
