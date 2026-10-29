import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zui/components/ui/select.js";
import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import { Cpu, Layers, ListChecks, Plus, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";
import { useDirectoryPickerAvailable } from "./canvasProjectDirectories.js";
import { localCuaDesktopInvoke } from "./cuaPermissionPlatform.js";
import {
  createFlowProject,
  selectFlowProject,
  useFlowProjectsController,
  useFlowProjectsSnapshot,
} from "./flowProjects.js";
import {
  getFlowNavigationReady,
  getFlowSurfaceView,
  navigateFlowSurface,
  setFlowSurfaceView,
  subscribeFlowSurface,
} from "./flowSurfaceState.js";
import { SharedProjectNavigation } from "./SharedProjectNavigation.js";

const NOOP_SUBSCRIBE = () => () => {};
const CODE_SNAPSHOT = {
  mode: "code" as const,
  availableModes: [] as readonly never[],
};

/** Flow 导航项（原 CanvasSidebar flow 区同款元素：导航归宿主，ff-embed/navigate 驱动站内路由）。 */
const FLOW_NAV_ITEMS = [
  { path: "/", label: "工作流", icon: Workflow },
  { path: "/plugins", label: "工作流插件", icon: Layers },
  { path: "/tasks", label: "任务中心", icon: ListChecks },
] as const;

/**
 * 壳侧栏的模式内容槽（融合缝）。用户拍板的最终结构（自上而下）：
 * 品牌行 → Code/Design/Flow 选项卡（高亮选中）→ **共用按钮**（插件市场/技能/
 * MCP/插件面板，所有模式都在）→ **分界线** → 模式专属内容（Code=新建任务/
 * 搜索/任务列表；Design=项目列表；Flow=工作流导航）→ 底部用户/设置。
 */
export function HostModeSidebarContent({
  children,
  shared,
}: {
  children?: ReactNode;
  shared?: ReactNode;
}) {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const snapshot = useSyncExternalStore(
    navigation?.subscribe ?? NOOP_SUBSCRIBE,
    navigation?.getSnapshot ?? (() => CODE_SNAPSHOT),
  );
  const mode = snapshot.mode;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {shared}
      {/* 分界线：共用按钮与各模式专属内容之间（用户口径）。 */}
      <div className="mx-3 my-2 border-t border-foreground/20" />
      {mode === "flow" ? (
        <FlowNavSidebar />
      ) : (
        <>
          <SharedProjectNavigation />
          {children}
        </>
      )}
    </div>
  );
}

/** Flow 模式的侧栏内容：工作流/插件/任务中心/引擎（原 CanvasSidebar flow 区同款）。 */
function FlowNavSidebar() {
  const view = useSyncExternalStore(subscribeFlowSurface, getFlowSurfaceView);
  const navigationReady = useSyncExternalStore(
    subscribeFlowSurface,
    getFlowNavigationReady,
  );
  useFlowProjectsController();
  const { projects, selectedProjectId, creating, notice } =
    useFlowProjectsSnapshot();
  const pickerAvailable = useDirectoryPickerAvailable();
  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );
  return (
    <nav
      className="flex min-h-0 flex-1 flex-col px-2 pt-2"
      aria-label="Flow 导航"
    >
      <div className="flex items-center gap-2 pb-2">
        <Select
          value={selectedProjectId ?? ""}
          onValueChange={(value) => selectFlowProject(value || null)}
        >
          <SelectTrigger
            aria-label="Flow 项目"
            variant="ghost"
            size="default"
            className="min-w-0 flex-1"
          >
            <SelectValue placeholder="选择项目" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-label="创建 Flow 项目"
          disabled={creating}
          onClick={() => void createFlowProject()}
          className="rounded-md p-1"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ProjectDirectoryOpen path={selectedProject?.workDir ?? null} />
      {pickerAvailable ? (
        <button
          type="button"
          disabled={creating}
          onClick={() => void createFlowProject(true)}
          className="rounded-md px-2 py-1.5 text-left text-xs text-foreground-subtle hover:bg-surface-hover"
        >
          选目录新建
        </button>
      ) : null}
      {notice ? (
        <p role="alert" className="pb-2 text-xs text-destructive">
          {notice}
        </p>
      ) : null}
      {FLOW_NAV_ITEMS.map((item) => {
        const disabled =
          !selectedProjectId || (item.path !== "/" && !navigationReady);
        return (
          <button
            key={item.path}
            type="button"
            disabled={disabled}
            onClick={() => navigateFlowSurface(item.path)}
            className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </button>
        );
      })}
      {/* 引擎（FORM-11 托管）：独立信息页——状态 / 承载路径 / 地址 / 栈容器事实。 */}
      <button
        type="button"
        data-active={view === "engine" ? "true" : undefined}
        onClick={() => setFlowSurfaceView("engine")}
        className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground data-[active=true]:bg-selected data-[active=true]:text-foreground"
      >
        <Cpu className="h-4 w-4 shrink-0" />
        引擎
      </button>
    </nav>
  );
}

function ProjectDirectoryOpen({ path }: { path: string | null }) {
  const [error, setError] = useState<string | null>(null);
  if (!path || !localCuaDesktopInvoke()) return null;
  return (
    <>
      <button
        type="button"
        className="rounded-md px-2 py-1.5 text-left text-xs text-foreground-subtle hover:bg-surface-hover"
        onClick={() => {
          setError(null);
          void localCuaDesktopInvoke()?.("reveal_path", { path }).catch(
            (failure: unknown) =>
              setError(
                failure instanceof Error
                  ? failure.message
                  : "目录无法打开，请检查目录权限。",
              ),
          );
        }}
      >
        打开目录
      </button>
      {error ? (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
