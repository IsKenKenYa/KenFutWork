import { useOptionalPlatform } from "@zui/hooks/usePlatform.js";
import {
  Cpu,
  Layers,
  ListChecks,
  Palette,
  Pencil,
  Plus,
  Trash2,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  type CanvasProject,
  createDesignProject,
  removeDesignProject,
  renameDesignProject,
  selectDesignProject,
  useDesignProjectsController,
  useDesignProjectsSnapshot,
} from "./designProjects.js";
import {
  getFlowSurfaceView,
  navigateFlowSurface,
  setFlowSurfaceView,
  subscribeFlowSurface,
} from "./flowSurfaceState.js";

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
 * 壳侧栏的模式内容槽（融合缝）：Code 模式渲染原任务列表（children），
 * Design/Flow 模式换成对应内容——「侧边栏随模式变化」的原工作台逻辑
 * （用户口径：融合这块逻辑，不要在主区再套一层侧栏）。品牌行与模式 pills
 * 在本槽之上，底部用户/设置在本槽之下，均不随模式变化。
 */
export function HostModeSidebarContent({ children }: { children?: ReactNode }) {
  const navigation = useOptionalPlatform()?.workbenchNavigation;
  const snapshot = useSyncExternalStore(
    navigation?.subscribe ?? NOOP_SUBSCRIBE,
    navigation?.getSnapshot ?? (() => CODE_SNAPSHOT),
  );
  const mode = snapshot.mode;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mode === "design" ? (
        <DesignProjectsSidebar />
      ) : mode === "flow" ? (
        <FlowNavSidebar />
      ) : (
        children
      )}
    </div>
  );
}

/** Design 模式的侧栏内容：项目列表（新建/行内改名/删除——原 CanvasSidebar 项目区同款元素）。
 *  独立导出供测试直接挂载（生产路径经 HostModeSidebarContent 按模式切换）。 */
export function DesignProjectsSidebar() {
  useDesignProjectsController(true);
  const { projects, selectedProjectId, creating, notice } =
    useDesignProjectsSnapshot();
  return (
    <div className="flex min-h-0 flex-1 flex-col px-2 pt-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs text-muted-foreground">项目</span>
        <button
          type="button"
          aria-label="创建项目"
          title="创建项目"
          disabled={creating}
          onClick={() => void createDesignProject()}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
        {projects.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {creating ? "创建中…" : "暂无项目"}
          </p>
        ) : (
          projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              active={selectedProjectId === project.id}
              onOpen={() => selectDesignProject(project.id)}
              onRename={(next) => void renameDesignProject(project.id, next)}
              onDelete={() => void removeDesignProject(project.id)}
            />
          ))
        )}
      </div>
      {notice ? (
        <p role="alert" className="border-t px-2 py-2 text-xs text-destructive">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** 项目行：点击选中；hover 出「重命名 / 删除」；重命名走行内输入（原 SidebarRow 行为）。 */
function ProjectRow({
  project,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  project: CanvasProject;
  active: boolean;
  onOpen: () => void;
  onRename: (next: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setDraft(project.name);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, project.name]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== project.name) onRename(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        aria-label="重命名"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setEditing(false);
        }}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none"
      />
    );
  }
  return (
    <div
      className="group/row relative flex items-center rounded-md hover:bg-muted data-[active=true]:bg-muted"
      data-active={active ? "true" : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
      >
        <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{project.name}</span>
      </button>
      <div className="absolute right-1 hidden items-center group-hover/row:flex">
        <button
          type="button"
          aria-label={`重命名 ${project.name}`}
          onClick={() => setEditing(true)}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={`删除 ${project.name}`}
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/** Flow 模式的侧栏内容：工作流/插件/任务中心/引擎（原 CanvasSidebar flow 区同款）。 */
function FlowNavSidebar() {
  const view = useSyncExternalStore(subscribeFlowSurface, getFlowSurfaceView);
  return (
    <nav
      className="flex min-h-0 flex-1 flex-col px-2 pt-2"
      aria-label="Flow 导航"
    >
      {FLOW_NAV_ITEMS.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={() => navigateFlowSurface(item.path)}
          className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <item.icon className="h-4 w-4 shrink-0" />
          {item.label}
        </button>
      ))}
      {/* 引擎（FORM-11 托管）：独立信息页——状态 / 承载路径 / 地址 / 栈容器事实。 */}
      <button
        type="button"
        data-active={view === "engine" ? "true" : undefined}
        onClick={() => setFlowSurfaceView("engine")}
        className="flex min-h-[36px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
      >
        <Cpu className="h-4 w-4 shrink-0" />
        引擎
      </button>
    </nav>
  );
}
