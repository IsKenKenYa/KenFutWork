"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import { LOCAL_ACCESS_LOST_EVENT } from "@/lib/local-access";
import { LocalAccessClientsSection } from "./local-access-clients-section";
import { LocalInstanceSection } from "./local-instance-section";

/** Code 的独立原文档保护 Design 的 CSS、theme 与 portal。 */
export function CodeWorkbenchFrame({
  onModeChange,
}: {
  onModeChange: (mode: "design") => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const ready = useRef(false);
  const bootstrap = useCallback(() => {
    if (!ready.current) return;
    const message: CodeUiBootstrap = {
      type: "kenfutwork:code-bootstrap",
      apiBase: new URL(
        getServerBaseUrl() || window.location.origin,
        window.location.origin,
      )
        .toString()
        .replace(/\/$/, ""),
      user: null,
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const parsed = codeUiParentRequestSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "kenfutwork:code-navigate")
        onModeChange(parsed.data.mode);
      else if (parsed.data.type === "kenfutwork:code-access-lost")
        window.dispatchEvent(new Event(LOCAL_ACCESS_LOST_EVENT));
      else {
        ready.current = true;
        bootstrap();
      }
    };
    window.addEventListener("message", receive);
    bootstrap();
    return () => window.removeEventListener("message", receive);
  }, [bootstrap, onModeChange]);
  return (
    <>
      <iframe
        ref={frame}
        src="/code-ui/index.html"
        title="Code 工作台"
        className="block h-dvh w-full border-0"
      />
      <button
        type="button"
        onClick={() => setInstanceOpen(true)}
        className="fixed bottom-3 right-3 z-20 rounded-md border bg-background/95 px-3 py-1.5 text-xs shadow-sm"
      >
        本地实例
      </button>
      <Dialog open={instanceOpen} onOpenChange={setInstanceOpen}>
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
          aria-describedby={undefined}
        >
          <DialogTitle>本地实例设置</DialogTitle>
          <LocalInstanceSection />
          <LocalAccessClientsSection />
        </DialogContent>
      </Dialog>
    </>
  );
}
