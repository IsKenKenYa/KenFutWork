"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
} from "@kenfutwork/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { getServerBaseUrl } from "@/lib/env";

/** Code 的独立原文档保护 Design 的 CSS、theme 与 portal。 */
export function CodeWorkbenchFrame({
  onModeChange,
}: {
  onModeChange: (mode: "design") => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const { user, session, loading } = useAuth();
  const router = useRouter();
  const bootstrap = useCallback(() => {
    if (loading || !user || !ready.current) return;
    const message: CodeUiBootstrap = {
      type: "kenfutwork:code-bootstrap",
      apiBase: new URL(
        getServerBaseUrl() || window.location.origin,
        window.location.origin,
      )
        .toString()
        .replace(/\/$/, ""),
      ...(session?.access_token ? { accessToken: session.access_token } : {}),
      user: {
        id: user.id,
        username: user.email ?? "",
        displayName: user.displayName ?? "本机用户",
      },
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [loading, user, session]);
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);
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
    <iframe
      ref={frame}
      src="/code-ui/index.html"
      title="Code 工作台"
      className="h-dvh w-full border-0"
    />
  );
}
