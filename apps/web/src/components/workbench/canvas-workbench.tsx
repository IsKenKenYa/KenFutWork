"use client";

import type { ManagementTarget } from "@kenfutwork/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFlowHostEntry } from "@/hooks/use-flow-host";
import { installDesktopExternalLinks } from "@/lib/desktop-system";
import { SIDEBAR_RAIL_WIDTH } from "@/lib/panel-layout";
import { useFlowEngineInstall } from "@/lib/use-flow-engine-install";
import {
  resolveWorkbenchSurface,
  type WorkbenchMode,
} from "@/lib/workbench-surface";
import { CanvasSidebar } from "./canvas-workbench/canvas-sidebar";
import { DesignHome } from "./canvas-workbench/design-home";
import { FullAccessDialog } from "./canvas-workbench/full-access-dialog";
import { useDesignComposer } from "./canvas-workbench/use-design-composer";
import { useDesignProjects } from "./canvas-workbench/use-design-projects";
import { useSidebarWidth } from "./canvas-workbench/use-sidebar-width";
import {
  FlowCanvasFrame,
  type FlowCanvasFrameHandle,
} from "./flow-canvas-frame";
import { FlowEnginePage } from "./flow-engine-page";
import { SettingsModal, type SettingsTab } from "./settings-modal";

/** 保留画布工作台。对话与运行均在画布页，Code 由独立原宿主负责。 */
export function CanvasWorkbench({
  mode,
  onModeChange,
  active = true,
  onOpenManagement,
}: {
  mode: "design" | "flow";
  onModeChange: (mode: WorkbenchMode) => void;
  active?: boolean;
  onOpenManagement: (target: ManagementTarget) => void;
}) {
  const accessToken = null;
  const { entry: flowEntry } = useFlowHostEntry();
  const flowFrameRef = useRef<FlowCanvasFrameHandle>(null);
  const canvasFrameRef = useRef<HTMLIFrameElement>(null);
  const sendCanvasActivity = useCallback(() => {
    canvasFrameRef.current?.contentWindow?.postMessage(
      { type: "kenfutwork:workspace-activity", active },
      window.location.origin,
    );
  }, [active]);
  useEffect(sendCanvasActivity, [sendCanvasActivity]);
  const projects = useDesignProjects(accessToken, mode, canvasFrameRef);
  const composer = useDesignComposer();
  const { sidebarWidth, startSidebarResize } = useSidebarWidth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [canvasPrompt, setCanvasPrompt] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /**
   * Flow 子视图：`canvas` = 工作流画布（默认主界面）；`engine` = 「引擎」信息页
   * （状态 / 承载路径 / 地址 / 栈容器事实）。只被用户点侧栏导航切换，不被对话框顶掉
   * （与 Design 主区不变量同一条纪律）。安装状态与信息页共用一份 hook。
   */
  const [flowView, setFlowView] = useState<"canvas" | "engine">("canvas");
  const {
    state: engineState,
    notice: engineNotice,
    install: runEngineInstall,
    stop: runEngineStop,
  } = useFlowEngineInstall();
  const { selectedProject } = projects;
  const surface = resolveWorkbenchSurface({
    mode,
    hasSelectedProject: selectedProject !== null,
    hasActiveTask: false,
  });
  useEffect(() => {
    installDesktopExternalLinks();
  }, []);
  useEffect(() => {
    if (active && mode === "flow" && flowEntry && !flowEntry.available)
      onModeChange("design");
  }, [mode, flowEntry, onModeChange, active]);
  if (mode === "flow" && !flowEntry?.available) return null;

  return (
    <div
      className="flex h-screen bg-background text-foreground"
      style={
        {
          "--workbench-sidebar": `${sidebarCollapsed ? SIDEBAR_RAIL_WIDTH : sidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <CanvasSidebar
        {...projects}
        mode={mode}
        active={active}
        switchMode={onModeChange}
        sidebarWidth={sidebarWidth}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        startSidebarResize={startSidebarResize}
        setSettingsTab={setSettingsTab}
        onOpenManagement={onOpenManagement}
        flowEntry={flowEntry}
        flowFrameRef={flowFrameRef}
        flowView={flowView}
        setFlowView={setFlowView}
      />
      <main className="min-w-0 flex-1 overflow-hidden bg-card">
        {mode === "flow" && flowEntry?.available ? (
          flowView === "engine" ? (
            <FlowEnginePage
              engineState={engineState}
              engineNotice={engineNotice}
              onInstall={runEngineInstall}
              onStop={runEngineStop}
            />
          ) : (
            <FlowCanvasFrame
              ref={flowFrameRef}
              frontendUrl={flowEntry.frontendUrl}
              active={active}
            />
          )
        ) : surface === "canvas" ? (
          <iframe
            ref={canvasFrameRef}
            onLoad={sendCanvasActivity}
            inert={!active}
            tabIndex={active ? 0 : -1}
            key={`${selectedProject?.primaryCanvas.id}:${canvasPrompt ?? ""}`}
            src={`/canvas?id=${selectedProject?.primaryCanvas.id}${canvasPrompt ? `&prompt=${encodeURIComponent(canvasPrompt)}` : ""}`}
            title={`${selectedProject?.name ?? ""} 画布`}
            className="h-full w-full border-0"
          />
        ) : (
          <DesignHome
            composer={composer}
            notice={projects.notice}
            selectedProject={selectedProject}
            setSettingsTab={setSettingsTab}
            onSubmit={(text) => {
              if (text.trim()) setCanvasPrompt(text.trim());
            }}
          />
        )}
      </main>
      <FullAccessDialog composer={composer} active={active} />
      <SettingsModal
        open={active && settingsTab !== null}
        initialTab={settingsTab === null ? undefined : settingsTab}
        onClose={() => setSettingsTab(null)}
        accessToken={accessToken}
        hasWorkDir={composer.hasWorkDir}
        conversationCount={0}
        key={mode}
      />
    </div>
  );
}
