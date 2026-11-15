import { type ReactNode, useLayoutEffect } from "react";

/** React 提交内容后即撤下遮罩；后台 WKWebView 可能不会调度动画帧。 */
export function StartupOverlayHandoff({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const overlay = document.getElementById("zcode-boot");
    if (!overlay) return;
    overlay.remove();
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: "kenfutwork:code-mounted" },
        window.location.origin,
      );
    }
  }, []);
  return children;
}
