import { workbenchNavigationSchema } from "@kenfutwork/shared";
import type { HostWorkbenchMode, HostWorkbenchNavigation } from "@zcode/shared";

/** 模式消息只来自同源父窗口，Code原树的interfaceMode始终保持coding。 */
export function createHostWorkbenchNavigation(
  parent: Window,
  availableModes: readonly HostWorkbenchMode[],
): HostWorkbenchNavigation & { dispose: () => void } {
  let snapshot = { mode: "code" as const, availableModes };
  const listeners = new Set<() => void>();
  const receive = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== window.location.origin)
      return;
    const parsed = workbenchNavigationSchema.safeParse(event.data);
    if (!parsed.success) return;
    snapshot = { mode: "code", availableModes: parsed.data.availableModes };
    for (const listener of listeners) listener();
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
      if (mode === "code" || !snapshot.availableModes.includes(mode)) return;
      parent.postMessage(
        { type: "kenfutwork:code-navigate", mode },
        window.location.origin,
      );
    },
    dispose: () => {
      window.removeEventListener("message", receive);
      listeners.clear();
    },
  };
}
