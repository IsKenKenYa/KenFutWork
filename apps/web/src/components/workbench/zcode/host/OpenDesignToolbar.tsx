import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import {
  Camera,
  Check,
  CloudUpload,
  Code2,
  Download,
  Eye,
  FolderDown,
  FolderInput,
  Globe,
  Highlighter,
  History,
  MessageSquarePlus,
  Monitor,
  PanelRight,
  PenTool,
  Plus,
  RefreshCw,
  Share2,
  Smartphone,
  SquarePen,
  Tablet,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * 画布工具栏（本仓口径，替代上游 FileViewer 那两行 chrome）。
 *
 * 上游控件逐项映射见台账 §二百〇四：「+」（新建画布 / 打开画布 / 上传资源 /
 * 新建浏览器）/ 刷新 / 预览·代码 / 设备视口 / 截图到对话 /
 * 交给对话（上游 Handoff 的文件夹按钮）/ 历史记录 / 导出（PNG、HTML）/ 分享 / 缩放。
 * 评论、标注、可视化编辑是本仓自己的实现，不吃上游应用内运行时。
 */
export type OpenDesignViewMode = "preview" | "code";
export type OpenDesignViewport = "desktop" | "tablet" | "mobile";

/** 画布上的工作模式：互斥，同一时刻只有一种指针语义。 */
export type OpenDesignTool = "none" | "comment" | "annotate" | "edit";

/** 「+」里「打开画布」的一条：宿主代理的上游 project 概要。 */
export interface OpenDesignCanvasSummary {
  projectId: string;
  name: string;
}

export interface OpenDesignVersionSummary {
  id: string;
  label: string;
  version: number;
  createdAt: number;
  current: boolean;
}

export const OPEN_DESIGN_ZOOM_LEVELS = [50, 75, 100, 125, 150, 200] as const;

/** 「+」里最多列几块已有画布（再多的话走对话侧或刷新后找）。 */
const OPENABLE_CANVAS_LIMIT = 8;

const VIEWPORTS: Array<{
  id: OpenDesignViewport;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "desktop", label: "桌面端", icon: Monitor },
  { id: "tablet", label: "平板", icon: Tablet },
  { id: "mobile", label: "手机", icon: Smartphone },
];

export function OpenDesignToolbar({
  busy,
  hasCanvas,
  viewMode,
  onViewMode,
  viewport,
  onViewport,
  zoom,
  onZoom,
  tool,
  onTool,
  commentCount,
  sidebarOpen,
  onToggleSidebar,
  openableCanvases,
  onCreateCanvas,
  onOpenCanvas,
  onUploadAsset,
  onOpenBrowserTab,
  onSyncContext,
  onSaveToWorkspace,
  saveToWorkspaceBusy,
  versions,
  versionsLoading,
  activeVersionId,
  onSelectVersion,
  onRefresh,
  onScreenshot,
  onHandoff,
  onExportPng,
  onExportHtml,
  onShare,
  shareBusy,
  shareMenuOpen,
  lastDeploymentUrl,
  onDeploy,
  onShareConfig,
  onOpenDeployment,
}: {
  busy: boolean;
  hasCanvas: boolean;
  viewMode: OpenDesignViewMode;
  onViewMode: (mode: OpenDesignViewMode) => void;
  viewport: OpenDesignViewport;
  onViewport: (viewport: OpenDesignViewport) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  /** 当前工作模式（评论/标注/编辑互斥）；再点一次退出。 */
  tool: OpenDesignTool;
  onTool: (tool: OpenDesignTool) => void;
  /** 未解决评论数（与画布上的图钉数一致）；侧栏按钮上的读数。 */
  commentCount: number;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** 「+」的「打开画布」清单（宿主代理的上游 project；空数组 = 只有「新建」）。 */
  openableCanvases: OpenDesignCanvasSummary[];
  onCreateCanvas: () => void;
  onOpenCanvas: (projectId: string) => void;
  /** 选中文件即上传到当前画布（没有画布时先新建一块再传）。 */
  onUploadAsset: (file: File) => void;
  onOpenBrowserTab: () => void;
  /** 同步评审上下文到设计引擎（document.md 受管段）。 */
  onSyncContext: () => void;
  onSaveToWorkspace: () => void;
  saveToWorkspaceBusy: boolean;
  versions: OpenDesignVersionSummary[] | null;
  versionsLoading: boolean;
  activeVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  onRefresh: () => void;
  onScreenshot: () => void;
  onHandoff: () => void;
  onExportPng: () => void;
  onExportHtml: () => void;
  onShare: () => void;
  shareBusy: boolean;
  shareMenuOpen: boolean;
  lastDeploymentUrl: string | null;
  onDeploy: (providerId: "cloudflare-pages" | "vercel-self") => void;
  onShareConfig: (providerId: "cloudflare-pages" | "vercel-self") => void;
  onOpenDeployment: () => void;
}) {
  const activeViewport = VIEWPORTS.find((item) => item.id === viewport);
  const ViewportIcon = activeViewport?.icon ?? Monitor;
  // 上传要有落点：没有当前画布时先由面板新建一块（与「新建画布」同一条宿主路由）。
  const uploadInput = (
    <input
      ref={(node) => {
        uploadInputRef.current = node;
      }}
      type="file"
      className="hidden"
      data-testid="open-design-upload-input"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onUploadAsset(file);
      }}
    />
  );

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      {uploadInput}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-foreground-subtle hover:text-foreground"
            aria-label="新建"
            title="新建"
            disabled={busy}
          >
            <Plus className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem
            data-open-design-add="canvas"
            onSelect={onCreateCanvas}
          >
            <PenTool className="size-3.5" />
            <span className="flex-1">新建画布</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="upload"
            onSelect={() => uploadInputRef.current?.click()}
          >
            <Upload className="size-3.5" />
            <span className="flex-1">上传资源</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="browser"
            onSelect={onOpenBrowserTab}
          >
            <Globe className="size-3.5" />
            <span className="flex-1">新建浏览器</span>
          </DropdownMenuItem>
          {openableCanvases.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>打开画布</DropdownMenuLabel>
              {openableCanvases
                .slice(0, OPENABLE_CANVAS_LIMIT)
                .map((canvas) => (
                  <DropdownMenuItem
                    key={canvas.projectId}
                    data-open-design-open={canvas.projectId}
                    onSelect={() => onOpenCanvas(canvas.projectId)}
                  >
                    <span className="flex-1 truncate">{canvas.name}</span>
                  </DropdownMenuItem>
                ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarIconButton
        label="刷新"
        disabled={busy || !hasCanvas}
        onClick={onRefresh}
      >
        <RefreshCw className="size-3" />
      </ToolbarIconButton>
      <div className="flex items-center rounded-md border border-border p-0.5">
        <ViewModeButton
          label="预览"
          active={viewMode === "preview"}
          onClick={() => onViewMode("preview")}
        >
          <Eye className="size-3" />
        </ViewModeButton>
        <ViewModeButton
          label="代码"
          active={viewMode === "code"}
          onClick={() => onViewMode("code")}
        >
          <Code2 className="size-3" />
        </ViewModeButton>
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1 text-foreground-subtle"
            aria-label="设备"
            title={`设备（${activeViewport?.label ?? "桌面端"}）`}
            disabled={busy || !hasCanvas || viewMode === "code"}
          >
            <ViewportIcon className="size-3" />
            <span>{activeViewport?.label ?? "桌面端"}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {VIEWPORTS.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => onViewport(item.id)}
            >
              <item.icon className="size-3.5" />
              <span className="flex-1">{item.label}</span>
              {viewport === item.id ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex flex-wrap items-center gap-0.5">
        <ToolbarToggleIconButton
          label="评论"
          active={tool === "comment"}
          disabled={busy || !hasCanvas || viewMode === "code"}
          onClick={() => onTool(tool === "comment" ? "none" : "comment")}
        >
          <MessageSquarePlus className="size-3" />
        </ToolbarToggleIconButton>
        <ToolbarIconButton
          label="评论侧栏"
          active={sidebarOpen}
          disabled={!hasCanvas}
          onClick={onToggleSidebar}
        >
          <PanelRight className="size-3" />
          {commentCount > 0 ? (
            <span className="text-ui-caption leading-none">{commentCount}</span>
          ) : null}
        </ToolbarIconButton>
        <ToolbarToggleIconButton
          label="标注"
          active={tool === "annotate"}
          disabled={busy || !hasCanvas || viewMode === "code"}
          onClick={() => onTool(tool === "annotate" ? "none" : "annotate")}
        >
          <Highlighter className="size-3" />
        </ToolbarToggleIconButton>
        <ToolbarToggleIconButton
          label="编辑"
          active={tool === "edit"}
          disabled={busy || !hasCanvas || viewMode === "code"}
          onClick={() => onTool(tool === "edit" ? "none" : "edit")}
        >
          <SquarePen className="size-3" />
        </ToolbarToggleIconButton>
        <ToolbarIconButton
          label="同步到引擎"
          disabled={busy || !hasCanvas}
          onClick={onSyncContext}
        >
          <CloudUpload className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="保存到工作目录"
          disabled={busy || saveToWorkspaceBusy || !hasCanvas}
          onClick={onSaveToWorkspace}
        >
          <FolderDown className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="截图到对话"
          disabled={busy || !hasCanvas}
          onClick={onScreenshot}
        >
          <Camera className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="交给对话"
          disabled={busy || !hasCanvas}
          onClick={onHandoff}
        >
          <FolderInput className="size-3" />
        </ToolbarIconButton>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-foreground-subtle hover:text-foreground"
              aria-label="历史记录"
              title="历史记录"
              disabled={busy || !hasCanvas}
            >
              <History className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-auto">
            <DropdownMenuItem onSelect={() => onSelectVersion(null)}>
              <span className="flex-1">当前版本</span>
              {activeVersionId === null ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
            {versionsLoading ? (
              <DropdownMenuItem disabled>读取中…</DropdownMenuItem>
            ) : (versions ?? []).length === 0 ? (
              <DropdownMenuItem disabled>没有历史版本</DropdownMenuItem>
            ) : (
              (versions ?? []).map((version) => (
                <DropdownMenuItem
                  key={version.id}
                  onSelect={() => onSelectVersion(version.id)}
                >
                  <span className="flex-1">
                    V{version.version} · {formatVersionTime(version.createdAt)}
                  </span>
                  {activeVersionId === version.id ? (
                    <Check className="size-3.5" />
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-foreground-subtle hover:text-foreground"
              aria-label="导出"
              title="导出"
              disabled={busy || !hasCanvas}
            >
              <Download className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onExportPng}>PNG 图片</DropdownMenuItem>
            <DropdownMenuItem onSelect={onExportHtml}>
              HTML 文件
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu modal={false} open={shareMenuOpen} onOpenChange={onShare}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-foreground-subtle hover:text-foreground"
              aria-label="分享"
              title="分享"
              disabled={busy || !hasCanvas}
            >
              <Share2 className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              data-open-design-share="cloudflare"
              disabled={shareBusy}
              onSelect={() => onDeploy("cloudflare-pages")}
            >
              发布到 Cloudflare Pages
            </DropdownMenuItem>
            <DropdownMenuItem
              data-open-design-share="vercel"
              disabled={shareBusy}
              onSelect={() => onDeploy("vercel-self")}
            >
              发布到 Vercel
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-open-design-share-config="cloudflare"
              onSelect={() => onShareConfig("cloudflare-pages")}
            >
              配置 Cloudflare
            </DropdownMenuItem>
            <DropdownMenuItem
              data-open-design-share-config="vercel"
              onSelect={() => onShareConfig("vercel-self")}
            >
              配置 Vercel
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-open-design-share-open=""
              disabled={!lastDeploymentUrl}
              onSelect={onOpenDeployment}
            >
              打开已发布页面
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground-subtle"
              aria-label="缩放"
              title="缩放"
              disabled={!hasCanvas || viewMode === "code"}
            >
              {zoom}%
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {OPEN_DESIGN_ZOOM_LEVELS.map((level) => (
              <DropdownMenuItem key={level} onSelect={() => onZoom(level)}>
                <span className="flex-1">{level}%</span>
                {zoom === level ? <Check className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/**
 * 上传用的隐藏 input：Radix 菜单项的 onSelect 里点它，比把 input 塞进菜单项更稳
 * （菜单关闭会销毁焦点，链式 click 需要在菜单外持有引用）。
 */
const uploadInputRef: { current: HTMLInputElement | null } = { current: null };

function formatVersionTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const date = new Date(timestamp);
  return `${date.toLocaleDateString("zh-CN")} ${date.toLocaleTimeString(
    "zh-CN",
    {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    },
  )}`;
}

function ViewModeButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="h-5 gap-1 px-1.5"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
      <span>{label}</span>
    </Button>
  );
}

function ToolbarIconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** 开关型按钮（如评论侧栏）的按下态。 */
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant={active ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={
          active
            ? "text-foreground"
            : "text-foreground-subtle hover:text-foreground"
        }
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

/** 工作模式按钮：按下态用 secondary + aria-pressed，一眼看出当前指针语义。 */
function ToolbarToggleIconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant={active ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={onClick}
        className={
          active
            ? "text-foreground"
            : "text-foreground-subtle hover:text-foreground"
        }
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
