"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
  type ManagementTarget,
} from "@kenfutwork/shared";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { getServerBaseUrl } from "@/lib/env";
import { LOCAL_ACCESS_LOST_EVENT } from "@/lib/local-access";
import { PLUGIN_INVENTORY_CHANGED_EVENT } from "@/lib/plugin-panels";

/** 独立原文档；关闭仅释放管理页，不触碰后台工作区。 */
export function ManagementDocumentFrame({
  target,
  onClose,
}: {
  target: ManagementTarget;
  onClose: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const parsed = codeUiParentRequestSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "kenfutwork:code-ready") {
        const bootstrap: CodeUiBootstrap = {
          type: "kenfutwork:code-bootstrap",
          apiBase: new URL(
            getServerBaseUrl() || window.location.origin,
            window.location.origin,
          )
            .toString()
            .replace(/\/$/, ""),
          user: null,
          management: target,
        };
        frame.current?.contentWindow?.postMessage(
          bootstrap,
          window.location.origin,
        );
      } else if (parsed.data.type === "kenfutwork:management-close") onClose();
      else if (parsed.data.type === "kenfutwork:code-plugins-changed")
        window.dispatchEvent(new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
      else if (parsed.data.type === "kenfutwork:code-access-lost")
        window.dispatchEvent(new Event(LOCAL_ACCESS_LOST_EVENT));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [target, onClose]);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="关闭管理页"
        className="fixed right-3 top-3 z-50 bg-background"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
      <iframe
        ref={frame}
        title="管理设置"
        src="/code-ui/index.html?document=management"
        className="fixed inset-0 z-40 h-dvh w-full border-0"
      />
    </>
  );
}
