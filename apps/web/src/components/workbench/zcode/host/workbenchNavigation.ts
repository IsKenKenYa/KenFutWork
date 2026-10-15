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
  admitMode?: (mode: HostWorkbenchMode) => Promise<boolean>,
): HostWorkbenchNavigation & { dispose: () => void } {
  let mode: HostWorkbenchMode = "code";
  try {
    const saved = window.sessionStorage.getItem("kenfutwork:workbench-mode");
    if (saved === "code" || saved === "design" || saved === "flow") {
      mode = availableModes.includes(saved)
        ? saved
        : saved === "flow"
          ? "design"
          : "code";
    }
  } catch {
    // 窗口偏好不可用时仍可打开工作台，项目权限继续由服务端验证。
  }
  let snapshot: {
    mode: HostWorkbenchMode;
    availableModes: readonly HostWorkbenchMode[];
    documentTarget?: { resourceType: "canvas"; documentId: string };
  } = { mode, availableModes };
  const listeners = new Set<() => void>();
  let modeRequest = 0;
  let disposed = false;
  const publish = (next: typeof snapshot) => {
    if (next.mode !== snapshot.mode) {
      try {
        window.sessionStorage.setItem("kenfutwork:workbench-mode", next.mode);
      } catch {
        // 仅保存当前窗口的界面选择，不影响本次导航或 Run 上下文。
      }
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const requestMode = (mode: HostWorkbenchMode) => {
    const request = ++modeRequest;
    if (!snapshot.availableModes.includes(mode)) return;
    if (!admitMode) {
      publish({ ...snapshot, mode });
      return;
    }
    void admitMode(mode)
      .then((allowed) => {
        if (
          !disposed &&
          allowed &&
          request === modeRequest &&
          snapshot.availableModes.includes(mode)
        )
          publish({ ...snapshot, mode });
      })
      .catch(() => {});
  };
  const receive = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== window.location.origin)
      return;
    const parsed = workbenchNavigationSchema.safeParse(event.data);
    if (!parsed.success) return;
    // 文档深链先解析真实项目并完成其准入，再由文档宿主切换工作方式。
    // 不能先为当前旧项目启用新方式，更不能在解析期间直接改主区。
    if (parsed.data.mode || parsed.data.documentTarget) modeRequest++;
    publish({
      // 不带 mode 的推送只更新可用模式，不改动当前模式（避免把壳内已切的面弹回去）。
      mode: snapshot.mode,
      availableModes: parsed.data.availableModes,
      ...(parsed.data.documentTarget
        ? { documentTarget: parsed.data.documentTarget }
        : snapshot.documentTarget
          ? { documentTarget: snapshot.documentTarget }
          : {}),
    });
    if (parsed.data.mode && !parsed.data.documentTarget)
      requestMode(parsed.data.mode);
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
      requestMode(mode);
    },
    setActiveMode: (mode) => {
      modeRequest++;
      if (mode === snapshot.mode) return;
      publish({ ...snapshot, mode });
    },
    dispose: () => {
      disposed = true;
      modeRequest++;
      window.removeEventListener("message", receive);
      listeners.clear();
    },
  };
}
