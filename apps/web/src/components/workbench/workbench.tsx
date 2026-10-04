"use client";

import type { ProjectSummary } from "@kenfutwork/shared";
import { TooltipProvider } from "@zui/components/ui/tooltip";
import { Blocks, Code2, Layers, ListChecks, Palette, PanelLeftClose, PanelLeftOpen, Plus, Server, Workflow } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { KenFutWorkLogo } from "@/components/icons/kenfutwork-logo";
import { Button } from "@/components/ui/button";
import { CodeWorkbenchFrame } from "@/components/workbench/code-workbench-frame";
import { FlowCanvasFrame, type FlowCanvasFrameHandle } from "@/components/workbench/flow-canvas-frame";
import { McpModal } from "@/components/workbench/mcp-modal";
import { PluginMarketModal } from "@/components/workbench/plugin-market-modal";
import { SettingsModal, type SettingsTab } from "@/components/workbench/settings-modal";
import { SidebarRow } from "@/components/workbench/sidebar-row";
import { SkillsModal } from "@/components/workbench/skills-modal";
import { UserMenu, type WorkbenchUser } from "@/components/workbench/user-menu";
import { useFlowHostEntry } from "@/hooks/use-flow-host";
import { useAuth } from "@/lib/auth-context";
import { resolveDesignAutoCanvas } from "@/lib/design-auto-canvas";
import { installDesktopExternalLinks } from "@/lib/desktop-system";
import { getServerBaseUrl } from "@/lib/env";
import { MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/lib/panel-layout";
import { PluginIcon, PluginPanelButtons } from "@/lib/plugin-panels";
import { createProject, deleteProject, fetchProjects, fetchViewer, updateProject } from "@/lib/server-api";
import { resolveWorkbenchSurface, type WorkbenchMode } from "@/lib/workbench-surface";

type VisualProject = Extract<ProjectSummary, { kind: "design" | "flow" }>;

/** Code 的唯一入口是原版 ZCode/V4；视觉模式只持有画布项目。 */
export function Workbench() {
  return <Suspense><WorkbenchModeSurface /></Suspense>;
}

function WorkbenchModeSurface() {
  const router = useRouter();
  const requested = useSearchParams().get("mode");
  const [mode, setMode] = useState<WorkbenchMode>(requested === "design" ? "design" : "code");
  useEffect(() => {
    setMode(requested === "design" ? "design" : "code");
  }, [requested]);
  const navigate = useCallback((next: WorkbenchMode) => {
    setMode(next);
    // Flow沿已有插件安装态入口切换；不因任意URL参数构造未安装的Flow入口。
    if (next !== "flow") router.replace(next === "code" ? "/workbench" : "/workbench?mode=design");
  }, [router]);
  return mode === "code" ? <CodeWorkbenchFrame onModeChange={navigate} /> : <VisualWorkbench mode={mode} setMode={navigate} />;
}

function VisualWorkbench({ mode, setMode }: { mode: "design" | "flow"; setMode: (mode: WorkbenchMode) => void }) {
  const router = useRouter();
  const { user, session, loading, signOut } = useAuth();
  const token = session?.access_token ?? null;
  const getToken = useCallback(() => token, [token]);
  const { entry: flowEntry, refresh: refreshFlowEntry } = useFlowHostEntry(token);
  const flowFrameRef = useRef<FlowCanvasFrameHandle>(null);
  const [projects, setProjects] = useState<VisualProject[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workbenchUser, setWorkbenchUser] = useState<WorkbenchUser | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const surface = resolveWorkbenchSurface({ mode, hasSelectedProject: selectedProject !== null, hasActiveTask: false });

  useEffect(() => { if (!loading && !user) router.replace("/login"); }, [loading, user, router]);
  useEffect(() => { installDesktopExternalLinks(); }, []);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchViewer(token).then((viewer) => { if (!cancelled) setWorkbenchUser({ displayName: viewer.profile.displayName, email: viewer.profile.email, avatarUrl: viewer.profile.avatarUrl ?? null }); }).catch(() => {});
    fetch(`${getServerBaseUrl()}/api/admin/me`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.ok ? response.json() : { isAdmin: false }).then((data) => { if (!cancelled) setIsPlatformAdmin(Boolean(data.isAdmin)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [token]);
  const refreshProjects = useCallback(() => {
    if (!token) return;
    void fetchProjects(token, "design").then((result) => {
      setProjects(result.projects.filter((project): project is VisualProject => project.kind !== "code"));
      setProjectsLoaded(true);
    }).catch((error: unknown) => { setProjectsLoaded(true); setNotice(error instanceof Error ? error.message : "画布项目读取失败。"); });
  }, [token]);
  useEffect(() => { refreshProjects(); }, [refreshProjects]);
  const createProjectNamed = useCallback(async (name: string): Promise<VisualProject | null> => {
    if (!token) return null;
    setCreatingProject(true);
    try {
      const result = await createProject(token, { kind: "design", name });
      if (result.project.kind === "code") throw new Error("画布项目类型不匹配。");
      setProjects((previous) => [result.project as VisualProject, ...previous]);
      setNotice(null); return result.project;
    } catch (error) { setNotice(error instanceof Error ? error.message : "创建画布失败。"); return null; }
    finally { setCreatingProject(false); }
  }, [token]);
  const autoCanvasTriedRef = useRef(false);
  useEffect(() => {
    const decision = resolveDesignAutoCanvas({ mode, activeTaskId: null, creatingProject, projectsLoaded, designProjectIds: projects.map((project) => project.id), selectedProjectId, autoCreateTried: autoCanvasTriedRef.current });
    if (decision.kind === "select") setSelectedProjectId(decision.projectId);
    if (decision.kind === "create") { autoCanvasTriedRef.current = true; void createProjectNamed("未命名画布").then((project) => { if (project) setSelectedProjectId(project.id); }); }
  }, [mode, creatingProject, projectsLoaded, projects, selectedProjectId, createProjectNamed]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; projectId?: string } | null;
      if (data?.type === "workbench:project-created") { refreshProjects(); if (data.projectId) setSelectedProjectId(data.projectId); }
      if (data?.type === "workbench:project-deleted") { setSelectedProjectId((current) => current === data.projectId ? null : current); refreshProjects(); }
    };
    window.addEventListener("message", handler); return () => window.removeEventListener("message", handler);
  }, [refreshProjects]);
  const renameProject = async (projectId: string, name: string) => {
    if (!token) return;
    try { await updateProject(token, projectId, { name }); setProjects((previous) => previous.map((project) => project.id === projectId ? { ...project, name } : project)); }
    catch (error) { setNotice(error instanceof Error ? error.message : "重命名失败。"); }
  };
  const removeProject = async (projectId: string) => {
    if (!token) return;
    try { await deleteProject(token, projectId); setProjects((previous) => previous.filter((project) => project.id !== projectId)); setSelectedProjectId((current) => current === projectId ? null : current); refreshProjects(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "删除画布失败。"); }
  };
  const handleSignOut = async () => { await signOut(); router.replace("/login"); };
  const handlePluginUse = (name: string) => {
    setPluginsOpen(false);
    if (name === "mcp") setMcpOpen(true);
    else if (name === "skills") setSkillsOpen(true);
    else if (name === "canvas") setMode("design");
    else setSettingsTab(name === "model-providers" ? "providers" : name === "search" ? "browser" : "pluginPanels");
  };
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return 256;
    const saved = Number(
      window.localStorage.getItem("workbench:sidebar-width"),
    );
    return Number.isFinite(saved) &&
      saved >= MIN_SIDEBAR_WIDTH &&
      saved <= MAX_SIDEBAR_WIDTH
      ? saved
      : 256;
  });

  const startSidebarResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = sidebarWidth;
      const clamp = (next: number) =>
        Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, next));
      const onMove = (moveEvent: MouseEvent) => {
        setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX)));
      };
      const onUp = (upEvent: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.localStorage.setItem(
          "workbench:sidebar-width",
          String(clamp(startWidth + (upEvent.clientX - startX))),
        );
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );


  if (loading) return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">加载中…</div>;
  if (!user) return null;
  const availableModes: readonly WorkbenchMode[] = flowEntry?.available ? ["code", "design", "flow"] : ["code", "design"];
  const modeItems = availableModes.map((id) => ({ id, label: id === "code" ? "Code" : id === "design" ? "Design" : "Flow", icon: id === "code" ? <Code2 className="h-4 w-4 shrink-0" /> : id === "design" ? <Palette className="h-4 w-4 shrink-0" /> : <Workflow className="h-4 w-4 shrink-0" /> }));
  return <TooltipProvider><div className="flex h-screen overflow-hidden bg-background text-foreground">
              {sidebarCollapsed ? (
                /* 收起态：图标栏（模式切换 + 插件 + 底部头像） */
                <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-card py-2">
                  <KenFutWorkLogo className="mb-1 size-7 shrink-0" />
                  <button
                    type="button"
                    aria-label="展开侧栏"
                    onClick={() => setSidebarCollapsed(false)}
                    className="rounded-md p-2 hover:bg-muted"
                  >
                    <PanelLeftOpen className="h-4 w-4" />
                  </button>
                  <div className="my-1 w-6 border-t" />
                  {modeItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      title={item.label}
                      aria-label={item.label}
                      data-active={mode === item.id}
                      onClick={() => setMode(item.id)}
                      className="rounded-md p-2 hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground data-[active=false]:text-muted-foreground"
                    >
                      {item.icon}
                    </button>
                  ))}
                  <button
                    type="button"
                    title="插件"
                    aria-label="插件"
                    onClick={() => setPluginsOpen(true)}
                    className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Layers className="h-4 w-4" />
                  </button>
                  <div className="mt-auto">
                    <UserMenu
                      user={workbenchUser}
                      collapsed
                      isAdmin={isPlatformAdmin}
                      onOpenSettings={() => setSettingsTab("general")}
                      onOpenAdmin={() => router.push("/admin")}
                      onSignOut={handleSignOut}
                    />
                  </div>
                </aside>
              ) : (
                /* 展开态：logo + 模式切换 + 插件 + 项目(design) + 任务列表 + 底部个人中心 */
                <aside
                  style={{ width: sidebarWidth }}
                  className="relative flex shrink-0 flex-col border-r bg-card"
                >
                  {/* 拖拽把手：贴侧栏右边缘；向右拖 = 变宽 */}
                  {/* biome-ignore lint/a11y/useSemanticElements: 拖拽改宽的把手，不是 <hr>（内容分隔线） */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="调整侧栏宽度"
                    onMouseDown={startSidebarResize}
                    className="absolute top-0 -right-0.5 z-10 h-full w-1 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/20"
                  />
                  <div className="flex items-center justify-between px-3 pt-3 pb-2">
                    {/* 左内边距与下面的模式切换控件对齐（外层 px-3 + 分段控件内 p-1 ⇒ pl-4）；
                logo 与字标之间留 5px（用户口径） */}
                    <span className="flex items-center gap-[5px] pl-1">
                      <KenFutWorkLogo className="h-[15px] w-auto text-foreground" />
                      {/* 字标：Momo Trust Display + **三色**渐变（左深右浅；变量见 globals.css，
                  显式 sRGB 插值——oklab 中段会发灰显脏） */}
                      <span
                        className="font-wordmark bg-clip-text text-xl tracking-tight text-transparent"
                        style={{ backgroundImage: "var(--wordmark-gradient)" }}
                      >
                        KenFutWork
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label="收起侧栏"
                      onClick={() => setSidebarCollapsed(true)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <PanelLeftClose className="h-4 w-4" />
                    </button>
                  </div>

                  {/* 模式切换（开关式：一个分段控件内左右切换 Code / Design / Flow）。
              三段并存时每段只有 ~60px：内边距收到最小、文字 13px、超宽截断，
              否则最后一个（Flow）会被挤变形。 */}
                  <div className="px-2 pt-1 pb-0.5">
                    <div
                      role="radiogroup"
                      aria-label="模式切换"
                      className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5"
                    >
                      {modeItems.map((item) => (
                        // biome-ignore lint/a11y/useSemanticElements: 分段控件用的是 radiogroup/radio 模式（原生 radio 无法承载这套样式与布局）
                        <button
                          key={item.id}
                          type="button"
                          role="radio"
                          aria-checked={mode === item.id}
                          data-active={mode === item.id}
                          onClick={() => setMode(item.id)}
                          className="flex min-h-[30px] min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-sm"
                        >
                          {item.icon}
                          <span className="truncate">{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mx-3 my-2 border-t" />

                  <nav className="space-y-0.5 px-2">
                    <button
                      type="button"
                      onClick={() => setPluginsOpen(true)}
                      className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Layers className="h-4 w-4 shrink-0" /> 插件
                    </button>
                    <button
                      type="button"
                      onClick={() => setSkillsOpen(true)}
                      className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <Blocks className="h-4 w-4 shrink-0" /> 技能
                    </button>
                    <button
                      type="button"
                      onClick={() => setMcpOpen(true)}
                      className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {/* Server 而不是 Plug：插头字形天生窄（墨迹只占格子 58%），居中也会显得缩在
                  右边；Server 与相邻图标一样填满格子（92%），不必再做尺寸特例 */}
                      <Server className="h-4 w-4 shrink-0" /> MCP
                    </button>
                    {/* 插件面板（能力 `ui`）：侧栏槽位 */}
                    <PluginPanelButtons
                      accessToken={session?.access_token ?? null}
                      slot="sidebar"
                      renderButton={(panel, open) => (
                        <button
                          key={panel.id}
                          type="button"
                          onClick={open}
                          title={`插件 ${panel.pluginId} 提供的面板`}
                          className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          {/* 插件图标：单色渲染（跟随本行文字色），槽位与本体都 16px——
                      与 MCP/技能/插件 三个满格字形（墨迹 92%）同尺寸才不显小 */}
                          <PluginIcon
                            icon={panel.icon}
                            pluginId={panel.pluginId}
                          />{" "}
                          {panel.title}
                        </button>
                      )}
                    />
                  </nav>

                  <div className="mx-3 my-2 border-t" />

                  {mode === "flow" ? (
                    /* Flow：侧栏导航项由宿主承担（内嵌形态 flow 自己的侧栏隐藏），
               点击经 ff-embed/navigate 让 iframe 内的 flow 路由跳转；
               主仓侧不复制一份列表（不造第二套真相）。 */
                    <nav
                      className="flex min-h-0 flex-1 flex-col px-2"
                      aria-label="Flow 导航"
                    >
                      {[
                        {
                          path: "/",
                          label: "工作流",
                          icon: <Workflow className="h-4 w-4 shrink-0" />,
                        },
                        {
                          path: "/plugins",
                          label: "工作流插件",
                          icon: <Layers className="h-4 w-4 shrink-0" />,
                        },
                        {
                          path: "/tasks",
                          label: "任务中心",
                          icon: <ListChecks className="h-4 w-4 shrink-0" />,
                        },
                      ].map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          disabled={!flowEntry?.available}
                          onClick={() =>
                            flowFrameRef.current?.navigate(item.path)
                          }
                          className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {item.icon}
                          {item.label}
                        </button>
                      ))}
                    </nav>
                  ) : (
                    /* Design：项目列表（+ 直接创建，无任务列表） */
                    <div className="flex min-h-0 flex-1 flex-col px-2">
                      <div className="flex items-center justify-between px-1 pb-1">
                        <span className="text-xs text-muted-foreground">
                          项目
                        </span>
                        <button
                          type="button"
                          aria-label="创建项目"
                          title="创建项目"
                          disabled={creatingProject}
                          onClick={() => {
                            void createProjectNamed("未命名画布").then(
                              (project) => {
                                if (project) setSelectedProjectId(project.id);
                              },
                            );
                          }}
                          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-1">
                        {projects.length === 0 ? (
                          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                            {creatingProject ? "创建中…" : "暂无项目"}
                          </p>
                        ) : (
                          projects.map((p) => (
                            <SidebarRow
                              key={p.id}
                              label={p.name}
                              active={selectedProjectId === p.id}
                              icon={
                                <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              }
                              onOpen={() => {
                                setSelectedProjectId(p.id);
                              }}
                              onRename={(next) =>
                                void renameProject(p.id, next)
                              }
                              onDelete={() => void removeProject(p.id)}
                            />
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {/* 底部：个人中心（头像弹出） */}
                  <div className="border-t p-2">
                    <UserMenu
                      user={workbenchUser}
                      collapsed={false}
                      isAdmin={isPlatformAdmin}
                      onOpenSettings={() => setSettingsTab("general")}
                      onOpenAdmin={() => router.push("/admin")}
                      onSignOut={handleSignOut}
                    />
                  </div>
                </aside>
              )}


    <main className="min-w-0 flex-1 overflow-hidden bg-card">
      {mode === "flow" ? (
        flowEntry === null ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground">正在检查 flow 可用性…</div> : flowEntry.available ?
          <FlowCanvasFrame ref={flowFrameRef} frontendUrl={flowEntry.frontendUrl} getToken={getToken} /> :
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">{flowEntry.reason}</div>
      ) : surface === "canvas" && selectedProject ? (
        <iframe key={selectedProject.primaryCanvas.id} src={`/canvas?id=${selectedProject.primaryCanvas.id}`} title={`${selectedProject.name} 画布`} className="h-full w-full border-0" />
      ) : <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
        <Palette className="h-9 w-9" strokeWidth={2.5} /><h1 className="text-2xl font-medium">Design with KenFutWork</h1>
        {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
        <Button disabled={creatingProject} onClick={() => { void createProjectNamed("未命名画布").then((project) => { if (project) setSelectedProjectId(project.id); }); }}>创建画布</Button>
      </div>}
    </main>
    <SettingsModal open={settingsTab !== null} initialTab={settingsTab ?? undefined} onClose={() => setSettingsTab(null)} accessToken={token} activeTaskId={null} hasWorkDir={false} conversationCount={0} isAdmin={isPlatformAdmin} onOpenAdmin={() => router.push("/admin")} key={mode} />
    {pluginsOpen ? <PluginMarketModal open onUse={handlePluginUse} onClose={() => setPluginsOpen(false)} accessToken={token} canvasId={selectedProject?.primaryCanvas.id ?? null} isAdmin={isPlatformAdmin} onPluginsChanged={refreshFlowEntry} /> : null}
    {skillsOpen ? <SkillsModal open onClose={() => setSkillsOpen(false)} accessToken={token} canvasId={selectedProject?.primaryCanvas.id ?? null} /> : null}
    {mcpOpen ? <McpModal open onClose={() => setMcpOpen(false)} accessToken={token} /> : null}
  </div></TooltipProvider>;
}
