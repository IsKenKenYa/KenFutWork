"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { AgentGovernanceSettingsPanel } from "@/components/agent-governance-settings";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import { LOCAL_ACCESS_LOST_EVENT } from "@/lib/local-access";
import { LocalAccessClientsSection } from "./local-access-clients-section";
import { LocalInstanceSection } from "./local-instance-section";
import { VoiceSettingsSection } from "./voice-settings-section";

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
  /**
   * 外观主题桥：设置 → 外观（next-themes，默认跟随系统）解析后的结果同步给 Code iframe
   * （zai 主题口径 zai-light/zai-dark）——没有这座桥，外观切深色时 Code 工作台仍是浅色。
   * 握手响应后立即推一次（iframe 的监听器这时才就位），之后主题变化实时推。
   */
  const { resolvedTheme } = useTheme();
  const themeRef = useRef<"zai-dark" | "zai-light">("zai-light");
  const postTheme = useCallback(
    (theme: "zai-dark" | "zai-light") => {
      themeRef.current = theme;
      localStorage.setItem("zcode-theme", theme);
      frame.current?.contentWindow?.postMessage(
        { type: "kenfutwork:code-theme", theme },
        window.location.origin,
      );
    },
    [],
  );
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
        // iframe 的主题监听器这时才就位，补推当前外观主题
        postTheme(themeRef.current);
      }
    };
    window.addEventListener("message", receive);
    bootstrap();
    return () => window.removeEventListener("message", receive);
  }, [bootstrap, onModeChange, postTheme]);
  useEffect(() => {
    const zcodeTheme = resolvedTheme === "dark" ? "zai-dark" : "zai-light";
    postTheme(zcodeTheme);
  }, [postTheme, resolvedTheme]);
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
          {/* 语音设置复用设置页同一段：Code 模式就地调档，不必切回 Design */}
          <VoiceSettingsSection accessToken={null} />
          <AgentGovernanceSettingsPanel enabled={instanceOpen} />
        </DialogContent>
      </Dialog>
    </>
  );
}
