"use client";

import {
  type CodeUiBootstrap,
  codeUiParentRequestSchema,
  type ManagementTarget,
} from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentGovernanceSettingsPanel } from "@/components/agent-governance-settings";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getServerBaseUrl } from "@/lib/env";
import { LOCAL_ACCESS_LOST_EVENT } from "@/lib/local-access";
import {
  PLUGIN_INVENTORY_CHANGED_EVENT,
  type PluginPanelEntry,
  PluginPanelOverlay,
  usePluginPanels,
} from "@/lib/plugin-panels";
import { LocalAccessClientsSection } from "./local-access-clients-section";
import { LocalInstanceSection } from "./local-instance-section";
import { VoiceSettingsSection } from "./voice-settings-section";

/** Code 的独立原文档保护 Design 的 CSS、theme 与 portal。 */
export function CodeWorkbenchFrame({
  onModeChange,
  active = true,
  onOpenManagement,
}: {
  onModeChange: (mode: "design") => void;
  active?: boolean;
  onOpenManagement?: (target: ManagementTarget) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<PluginPanelEntry | null>(null);
  const {
    panels,
    refresh: refreshPanels,
    error: panelError,
  } = usePluginPanels(null, "sidebar", "code");
  const panelRequest = useRef(0);
  useEffect(() => {
    setActivePanel((current) =>
      current
        ? (panels.find((panel) => panel.id === current.id) ?? null)
        : null,
    );
  }, [panels]);
  const ready = useRef(false);
  const sendActivity = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "kenfutwork:workspace-activity", active },
      window.location.origin,
    );
  }, [active]);
  useEffect(sendActivity, [sendActivity]);
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
      ...(onOpenManagement ? { managementAvailable: true } : {}),
    };
    frame.current?.contentWindow?.postMessage(message, window.location.origin);
  }, [onOpenManagement]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const parsed = codeUiParentRequestSchema.safeParse(event.data);
      if (!parsed.success) return;
      if (parsed.data.type === "kenfutwork:code-navigate") {
        if (active) onModeChange(parsed.data.mode);
      } else if (parsed.data.type === "kenfutwork:open-management") {
        if (active) onOpenManagement?.(parsed.data.target);
      } else if (parsed.data.type === "kenfutwork:code-plugins-changed")
        window.dispatchEvent(new Event(PLUGIN_INVENTORY_CHANGED_EVENT));
      else if (parsed.data.type === "kenfutwork:code-open-plugin") {
        if (!active) return;
        const { pluginId, entryId } = parsed.data;
        const current = ++panelRequest.current;
        // 聚焦的并发读可使本次读取过期；仅补读库存，不重复写入。
        void refreshPanels()
          .then((entries) =>
            current === panelRequest.current
              ? (entries ?? refreshPanels())
              : null,
          )
          .then((entries) => {
            if (current !== panelRequest.current) return;
            setActivePanel(
              entries?.find(
                (entry) =>
                  entry.pluginId === pluginId && entry.entryId === entryId,
              ) ?? null,
            );
          });
      } else if (parsed.data.type === "kenfutwork:code-access-lost")
        window.dispatchEvent(new Event(LOCAL_ACCESS_LOST_EVENT));
      else if (parsed.data.type === "kenfutwork:code-ready") {
        ready.current = true;
        bootstrap();
        sendActivity();
      }
    };
    window.addEventListener("message", receive);
    bootstrap();
    return () => {
      panelRequest.current++;
      window.removeEventListener("message", receive);
    };
  }, [
    bootstrap,
    onModeChange,
    refreshPanels,
    active,
    sendActivity,
    onOpenManagement,
  ]);
  return (
    <>
      <iframe
        ref={frame}
        src="/code-ui/index.html"
        title="Code 工作台"
        className="block h-dvh w-full border-0"
        inert={!active}
        tabIndex={active ? 0 : -1}
      />
      <button
        type="button"
        onClick={() => setInstanceOpen(true)}
        className="fixed bottom-3 right-3 z-20 rounded-md border bg-background/95 px-3 py-1.5 text-xs shadow-sm"
      >
        本地实例
      </button>
      {panelError ? (
        <p
          role="alert"
          className="fixed bottom-14 right-3 text-sm text-destructive"
        >
          {panelError}
        </p>
      ) : null}
      <PluginPanelOverlay
        panel={activePanel}
        active={active}
        onClose={() => {
          panelRequest.current++;
          setActivePanel(null);
        }}
      />
      <Dialog open={active && instanceOpen} onOpenChange={setInstanceOpen}>
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
