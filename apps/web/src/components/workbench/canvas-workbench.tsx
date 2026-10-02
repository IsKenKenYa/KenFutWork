"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFlowHostEntry } from "@/hooks/use-flow-host";
import { useAuth } from "@/lib/auth-context";
import { installDesktopExternalLinks } from "@/lib/desktop-system";
import { SIDEBAR_RAIL_WIDTH } from "@/lib/panel-layout";
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
import { useWorkbenchViewer } from "./canvas-workbench/use-workbench-viewer";
import {
  FlowCanvasFrame,
  type FlowCanvasFrameHandle,
} from "./flow-canvas-frame";
import { McpModal } from "./mcp-modal";
import { PluginMarketModal } from "./plugin-market-modal";
import { SettingsModal, type SettingsTab } from "./settings-modal";
import { SkillsModal } from "./skills-modal";

/** 保留画布工作台。对话与运行均在画布页，Code 由独立原宿主负责。 */
export function CanvasWorkbench({
  mode,
  onModeChange,
}: {
  mode: "design" | "flow";
  onModeChange: (mode: WorkbenchMode) => void;
}) {
  const router = useRouter();
  const { user, session, loading, signOut } = useAuth();
  const accessToken = session?.access_token ?? null;
  const getToken = useCallback(() => accessToken, [accessToken]);
  const { entry: flowEntry, refresh: refreshFlowEntry } =
    useFlowHostEntry(accessToken);
  const flowFrameRef = useRef<FlowCanvasFrameHandle>(null);
  const projects = useDesignProjects(accessToken, mode);
  const viewer = useWorkbenchViewer(accessToken);
  const composer = useDesignComposer();
  const { sidebarWidth, startSidebarResize } = useSidebarWidth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [canvasPrompt, setCanvasPrompt] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const { selectedProject } = projects;
  const surface = resolveWorkbenchSurface({
    mode,
    hasSelectedProject: selectedProject !== null,
    hasActiveTask: false,
  });
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);
  useEffect(() => {
    installDesktopExternalLinks();
  }, []);
  useEffect(() => {
    if (mode === "flow" && flowEntry && !flowEntry.available)
      onModeChange("design");
  }, [mode, flowEntry, onModeChange]);
  const handleSignOut = useCallback(() => {
    void signOut();
    router.push("/login");
  }, [signOut, router]);
  const handlePluginUse = useCallback(
    (name: string) => {
      setPluginsOpen(false);
      if (name === "mcp") return setMcpOpen(true);
      if (name === "skills") return setSkillsOpen(true);
      if (name === "canvas") return onModeChange("design");
      setSettingsTab(
        name === "model-providers"
          ? "providers"
          : name === "search"
            ? "browser"
            : "pluginPanels",
      );
    },
    [onModeChange],
  );
  if (loading)
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        加载中…
      </div>
    );
  if (!user || (mode === "flow" && !flowEntry?.available)) return null;

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
        {...viewer}
        mode={mode}
        switchMode={onModeChange}
        sidebarWidth={sidebarWidth}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        startSidebarResize={startSidebarResize}
        setSettingsTab={setSettingsTab}
        setPluginsOpen={setPluginsOpen}
        setSkillsOpen={setSkillsOpen}
        setMcpOpen={setMcpOpen}
        handleSignOut={handleSignOut}
        session={session}
        flowEntry={flowEntry}
        flowFrameRef={flowFrameRef}
      />
      <main className="min-w-0 flex-1 overflow-hidden bg-card">
        {mode === "flow" && flowEntry?.available ? (
          <FlowCanvasFrame
            ref={flowFrameRef}
            frontendUrl={flowEntry.frontendUrl}
            getToken={getToken}
          />
        ) : surface === "canvas" ? (
          <iframe
            key={`${selectedProject?.primaryCanvas.id}:${canvasPrompt ?? ""}`}
            src={`/canvas?id=${selectedProject?.primaryCanvas.id}${canvasPrompt ? `&prompt=${encodeURIComponent(canvasPrompt)}` : ""}`}
            title={`${selectedProject?.name ?? ""} 画布`}
            className="h-full w-full border-0"
          />
        ) : (
          <DesignHome
            composer={composer}
            selectedProject={selectedProject}
            setSettingsTab={setSettingsTab}
            onSubmit={(text) => {
              if (text.trim() && accessToken) setCanvasPrompt(text.trim());
            }}
          />
        )}
      </main>
      <FullAccessDialog composer={composer} />
      <SettingsModal
        open={settingsTab !== null}
        initialTab={settingsTab === null ? undefined : settingsTab}
        onClose={() => setSettingsTab(null)}
        accessToken={accessToken}
        activeCanvasId={selectedProject?.primaryCanvas?.id ?? null}
        hasWorkDir={composer.hasWorkDir}
        conversationCount={0}
        isAdmin={viewer.isPlatformAdmin}
        onOpenAdmin={() => router.push("/admin")}
        key={mode}
      />
      {pluginsOpen ? (
        <PluginMarketModal
          open={pluginsOpen}
          onUse={handlePluginUse}
          onClose={() => setPluginsOpen(false)}
          accessToken={accessToken}
          canvasId={selectedProject?.primaryCanvas?.id ?? null}
          isAdmin={viewer.isPlatformAdmin}
          onPluginsChanged={refreshFlowEntry}
        />
      ) : null}
      {skillsOpen ? (
        <SkillsModal
          open={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          accessToken={accessToken}
          canvasId={selectedProject?.primaryCanvas?.id ?? null}
        />
      ) : null}
      {mcpOpen ? (
        <McpModal
          open={mcpOpen}
          onClose={() => setMcpOpen(false)}
          accessToken={accessToken}
        />
      ) : null}
    </div>
  );
}
