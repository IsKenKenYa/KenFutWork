import {
  type CodeUiBootstrap,
  codeUiBootstrapSchema,
} from "@kenfutwork/shared";

/** 独立 Code 文档从父宿主取得身份，凭证只留在内存。 */
export function requestParentBootstrap(
  parentWindow: Window,
): Promise<CodeUiBootstrap> {
  return new Promise((resolve) => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== parentWindow ||
        event.origin !== window.location.origin
      )
        return;
      const parsed = codeUiBootstrapSchema.safeParse(event.data);
      if (!parsed.success) return;
      window.removeEventListener("message", receive);
      resolve(parsed.data);
    };
    window.addEventListener("message", receive);
    parentWindow.postMessage(
      { type: "kenfutwork:code-ready" },
      window.location.origin,
    );
  });
}

export function navigateToDesign() {
  if (window.parent === window) {
    const target = new URL("/workbench", window.location.origin);
    target.searchParams.set("mode", "design");
    window.location.assign(target.href);
  } else {
    window.parent.postMessage(
      { type: "kenfutwork:code-navigate", mode: "design" },
      window.location.origin,
    );
  }
}

export function openPluginPanel(pluginId: string, entryId: string) {
  window.parent.postMessage(
    { type: "kenfutwork:code-open-plugin", pluginId, entryId },
    window.location.origin,
  );
}

export function notifyPluginInventoryChanged() {
  if (window.parent !== window)
    window.parent.postMessage(
      { type: "kenfutwork:code-plugins-changed" },
      window.location.origin,
    );
}
