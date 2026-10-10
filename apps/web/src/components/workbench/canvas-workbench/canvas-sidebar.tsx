"use client";
import type { ManagementTarget } from "@kenfutwork/shared";
import {
  Blocks,
  Code2,
  Cpu,
  Layers,
  ListChecks,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Server,
  Workflow,
} from "lucide-react";
import type { Dispatch, MouseEvent, RefObject, SetStateAction } from "react";
import { KenFutWorkLogo } from "@/components/icons/kenfutwork-logo";
import type { FlowEntry } from "@/lib/flow-embed";
import { PluginIcon, PluginPanelButtons } from "@/lib/plugin-panels";
import type { WorkbenchMode } from "@/lib/workbench-surface";
import type { FlowCanvasFrameHandle } from "../flow-canvas-frame";
import { InstanceMenu } from "../instance-menu";
import type { SettingsTab } from "../settings-modal";
import { SidebarRow } from "../sidebar-row";
import type { useDesignProjects } from "./use-design-projects";

type Props = ReturnType<typeof useDesignProjects> & {
  mode: "design" | "flow";
  active: boolean;
  switchMode: (mode: WorkbenchMode) => void;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  startSidebarResize: (event: MouseEvent) => void;
  setSettingsTab: Dispatch<SetStateAction<SettingsTab | null>>;
  onOpenManagement: (target: ManagementTarget) => void;
  flowEntry: FlowEntry | null;
  flowFrameRef: RefObject<FlowCanvasFrameHandle | null>;
  /** Flow 子视图：「引擎」是侧栏导航的显式目的地（信息页），其余项回画布。 */
  flowView: "canvas" | "engine";
  setFlowView: Dispatch<SetStateAction<"canvas" | "engine">>;
};
/** 从原工作台提取的 Design/Flow 侧栏；Code 只执行宿主导航。 */
export function CanvasSidebar({
  projects,
  selectedProjectId,
  setSelectedProjectId,
  creatingProject,
  createProjectNamed,
  renameProject,
  removeProject,
  sidebarWidth,
  sidebarCollapsed,
  setSidebarCollapsed,
  startSidebarResize,
  mode,
  active,
  switchMode,
  setSettingsTab,
  onOpenManagement,
  flowEntry,
  flowFrameRef,
  flowView,
  setFlowView,
}: Props) {
  const availableModes: WorkbenchMode[] = flowEntry?.available
    ? ["code", "design", "flow"]
    : ["code", "design"];
  const modeItems = availableModes.map((id) => ({
    id,
    label: id === "code" ? "Code" : id === "design" ? "Design" : "Flow",
    icon:
      id === "code" ? (
        <Code2 className="h-4 w-4 shrink-0" />
      ) : id === "design" ? (
        <Palette className="h-4 w-4 shrink-0" />
      ) : (
        <Workflow className="h-4 w-4 shrink-0" />
      ),
  }));
  return (
    <>
      {sidebarCollapsed /* 收起态：图标栏（模式切换 + 插件 + 底部头像） */ ? (
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
              onClick={() => switchMode(item.id)}
              className="rounded-md p-2 hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground data-[active=false]:text-muted-foreground"
            >
              {item.icon}
            </button>
          ))}
          <button
            type="button"
            title="插件"
            aria-label="插件"
            onClick={() => onOpenManagement({ page: "plugins" })}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Layers className="h-4 w-4" />
          </button>
          <div className="mt-auto">
            <InstanceMenu
              collapsed
              onOpenSettings={() => setSettingsTab("general")}
            />
          </div>
        </aside> /* 展开态：logo + 模式切换 + 插件 + 项目(design) + 任务列表 +
      底部个人中心 */
      ) : (
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
                  onClick={() => switchMode(item.id)}
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
              onClick={() => onOpenManagement({ page: "plugins" })}
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Layers className="h-4 w-4 shrink-0" /> 插件
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenManagement({ page: "settings", section: "skill" })
              }
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Blocks className="h-4 w-4 shrink-0" /> 技能
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenManagement({ page: "settings", section: "mcp" })
              }
              className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {/* Server 而不是 Plug：插头字形天生窄（墨迹只占格子 58%），居中也会显得缩在
                  右边；Server 与相邻图标一样填满格子（92%），不必再做尺寸特例 */}
              <Server className="h-4 w-4 shrink-0" /> MCP
            </button>
            {/* 插件面板（能力 `ui`）：侧栏槽位 */}
            <PluginPanelButtons
              accessToken={null}
              slot="sidebar"
              mode={mode}
              workspaceActive={active}
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
                  <PluginIcon icon={panel.icon} pluginId={panel.pluginId} />{" "}
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
                  onClick={() => {
                    // 从「引擎」页回到画布导航项：切回画布再让 iframe 内路由跳转
                    setFlowView("canvas");
                    flowFrameRef.current?.navigate(item.path);
                  }}
                  className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
              {/* 引擎（FORM-11 托管）：独立信息页——状态 / 承载路径 / 地址 / 栈容器事实；
                  样式与上面三个导航项同款（行高/间距/hover 一致，内嵌协议不上报 iframe
                  内路由，故不单独做选中态）。 */}
              <button
                type="button"
                onClick={() => setFlowView("engine")}
                className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Cpu className="h-4 w-4 shrink-0" />
                引擎
              </button>
            </nav>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col px-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-xs text-muted-foreground">项目</span>
                <button
                  type="button"
                  aria-label="创建项目"
                  title="创建项目"
                  disabled={creatingProject}
                  onClick={() => {
                    void createProjectNamed("未命名画布").then((project) => {
                      if (project) setSelectedProjectId(project.id);
                    });
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
                      onRename={(next) => void renameProject(p.id, next)}
                      onDelete={() => void removeProject(p.id)}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {/* 底部：个人中心（头像弹出） */}
          <div className="border-t p-2">
            <InstanceMenu
              collapsed={false}
              onOpenSettings={() => setSettingsTab("general")}
            />
          </div>
        </aside>
      )}
    </>
  );
}
