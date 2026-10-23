import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  FileText,
  FolderDown,
  FolderInput,
  Globe,
  Highlighter,
  History,
  House,
  MapPin,
  MessageSquarePlus,
  Monitor,
  Eraser,
  MousePointer2,
  SquareMousePointer,
  Palette,
  PanelRight,
  Pencil,
  PenTool,
  Plus,
  RefreshCw,
  Smartphone,
  SquareDashed,
  SquarePen,
  Tablet,
  Type,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * 画布工具栏（本仓口径，替代上游 FileViewer 那两行 chrome）。
 *
 * 上游控件逐项映射见台账 §二百〇四：「+」（新建草图 / 新建文档 / 上传 /
 * 新建浏览器 / 新建设计体系）/ 返回资源 / 刷新 / 预览·代码 / 设备视口 / 截图到对话 /
 * 交给对话（上游 Handoff 的文件夹按钮）/ 历史记录 / 导出（PNG、HTML）/ 分享 / 缩放。
 * 评论、标注、可视化编辑是本仓自己的实现，不吃上游应用内运行时。
 */
export type OpenDesignViewMode = "preview" | "code";
export type OpenDesignViewport = "desktop" | "tablet" | "mobile";

/** 画布上的工作模式：互斥，同一时刻只有一种指针语义。 */
export type OpenDesignTool =
  | "none"
  | "comment"
  | "annotate"
  | "edit"
  | "erase"
  | "adjust"
  | "element";

export interface OpenDesignVersionSummary {
  id: string;
  label: string;
  version: number;
  createdAt: number;
  current: boolean;
}

export const OPEN_DESIGN_ZOOM_LEVELS = [50, 75, 100, 125, 150, 200] as const;

/** Figma 标志（lucide 新版已移除品牌图标，内联 Simple Icons 路径）。 */
export function FigmaMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.514-2.024-4.514-4.514s2.024-4.514 4.514-4.514h4.588v4.514c0 2.49-2.023 4.514-4.588 4.514zm0-7.51c-1.653 0-2.996 1.344-2.996 2.996s1.343 2.996 2.996 2.996 2.996-1.344 2.996-2.996V16.49H8.172zm8.172-3.02h-2.352v-1.49h2.352c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49-4.49-2.014-4.49-4.49v-1.49h2.352v1.49c0 1.665 1.355 3.019 3.019 3.019s3.019-1.354 3.019-3.019-1.354-3.019-3.019-3.019z" />
    </svg>
  );
}

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
  annotationKind,
  onAnnotationKind,
  commentCount,
  sidebarOpen,
  onToggleSidebar,
  showBack,
  onBackToResources,
  onCreateSketch,
  onCreateDocument,
  onCreateDesignFile,
  onUploadAsset,
  onOpenBrowserTab,
  onSyncContext,
  onSaveToWorkspace,
  saveToWorkspaceBusy,
  activeDesignSystemTitle,
  onOpenDesignSystems,
  onCreateDesignSystem,
  versions,
  versionsLoading,
  activeVersionId,
  onSelectVersion,
  onRefresh,
  onScreenshot,
  onHandoff,
  onExportPng,
  onExportHtml,
  onExportPdf,
  onExportZip,
  onShare,
  shareBusy,
  shareMenuOpen,
  lastDeploymentUrl,
  onDeploy,
  onShareConfig,
  onOpenDeployment,
  onCopyDeployedLink,
  markdownMode = false,
  fileName = null,
  onRename,
  markdownDirty = false,
  markdownSaving = false,
  onSaveMarkdown,
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
  /** 标注画笔形态：自由笔迹或拖框。 */
  annotationKind: "pen" | "rect" | "text" | "mark";
  onAnnotationKind: (kind: "pen" | "rect" | "text" | "mark") => void;
  /** 未解决评论数（与画布上的图钉数一致）；侧栏按钮上的读数。 */
  commentCount: number;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** 当前在某个资源里：显示「返回资源」。 */
  showBack: boolean;
  /** 回到项目资源页（草稿/设计/文档的列表）。 */
  onBackToResources: () => void;
  /** 新建草图 = 当前项目的 Design 画布。 */
  onCreateSketch: () => void;
  /** 新建 Markdown 文档，落在当前项目的设计资源里。 */
  onCreateDocument: () => void;
  /** 新建 HTML 设计稿，落在当前项目的设计资源里。 */
  onCreateDesignFile: () => void;
  /** 上传资源进当前项目。 */
  onUploadAsset: (file: File) => void;
  onOpenBrowserTab: () => void;
  /** 同步评审上下文到设计引擎（document.md 受管段）。 */
  onSyncContext: () => void;
  onSaveToWorkspace: () => void;
  saveToWorkspaceBusy: boolean;
  activeDesignSystemTitle: string | null;
  onOpenDesignSystems: () => void;
  /** 「+」里的「新建设计体系」：真正新建一份 draft 体系（不是选择已有）。 */
  onCreateDesignSystem: () => void;
  versions: OpenDesignVersionSummary[] | null;
  versionsLoading: boolean;
  activeVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
  onRefresh: () => void;
  onScreenshot: () => void;
  onHandoff: () => void;
  onExportPng: () => void;
  onExportHtml: () => void;
  onExportPdf: () => void;
  onExportZip: () => void;
  onShare: () => void;
  shareBusy: boolean;
  shareMenuOpen: boolean;
  lastDeploymentUrl: string | null;
  onDeploy: (providerId: "cloudflare-pages" | "vercel-self") => void;
  onShareConfig: (providerId: "cloudflare-pages" | "vercel-self") => void;
  onOpenDeployment: () => void;
  onCopyDeployedLink: () => void;
  /** Markdown 资源只保留返回、新建与预览/代码，画布类控件全部收起。 */
  markdownMode?: boolean;
  /** 当前资源名（顶部名字行；点它重命名）。 */
  fileName?: string | null;
  /** 顶部名字行与三点菜单共用的重命名入口。 */
  onRename?: () => void;
  /** 文档代码页：顶部「保存」按钮（无自动保存，只有显式保存）。 */
  markdownDirty?: boolean;
  markdownSaving?: boolean;
  onSaveMarkdown?: () => void;
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

  /** 名字行右侧：同步/保存/截图/交给/历史/导出与分享/缩放（用户口径：移到名字那一行）。 */
  const topActions = (
    <>
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
      {/* 下载与分享合并成一个菜单（用户口径） */}
      <DropdownMenu
        modal={false}
        open={shareMenuOpen}
        onOpenChange={onShare}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-foreground-subtle hover:text-foreground"
            aria-label="导出与分享"
            title="导出与分享"
            disabled={busy || !hasCanvas}
          >
            <Download className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={onExportPng}>PNG 图片</DropdownMenuItem>
          <DropdownMenuItem onSelect={onExportPdf}>PDF 文件</DropdownMenuItem>
          <DropdownMenuItem onSelect={onExportZip}>ZIP 项目包</DropdownMenuItem>
          <DropdownMenuItem onSelect={onExportHtml}>HTML 文件</DropdownMenuItem>
          <DropdownMenuSeparator />
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
          <DropdownMenuItem
            data-open-design-share-copy=""
            disabled={!lastDeploymentUrl}
            onSelect={onCopyDeployedLink}
          >
            复制已发布链接
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
    </>
  );

  return (
    <div className="flex shrink-0 flex-col">
      {fileName ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          <button
            type="button"
            aria-label="重命名文件"
            title="点击重命名"
            onClick={() => onRename?.()}
            className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-ui-base hover:bg-hover"
          >
            <span className="min-w-0 truncate">{fileName}</span>
            <Pencil className="size-3 shrink-0 text-foreground-subtle" />
          </button>
          {markdownMode ? (
            viewMode === "code" && onSaveMarkdown ? (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  disabled={!markdownDirty || markdownSaving}
                  onClick={onSaveMarkdown}
                >
                  {markdownSaving ? "保存中…" : "保存"}
                </Button>
              </div>
            ) : null
          ) : (
            <div className="ml-auto flex flex-wrap items-center gap-0.5">
              {topActions}
            </div>
          )}
        </div>
      ) : null}
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      {uploadInput}
      {showBack ? (
        <ToolbarIconButton label="返回资源" onClick={onBackToResources}>
          <House className="size-3" />
        </ToolbarIconButton>
      ) : null}
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
            data-open-design-add="sketch"
            onSelect={onCreateSketch}
          >
            <PenTool className="size-3.5" />
            <span className="flex-1">新建草图</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="document"
            onSelect={onCreateDocument}
          >
            <FileText className="size-3.5" />
            <span className="flex-1">新建文档</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="design-file"
            onSelect={onCreateDesignFile}
          >
            <FigmaMark className="size-3.5" />
            <span className="flex-1">新建设计稿</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="upload"
            onSelect={() => uploadInputRef.current?.click()}
          >
            <Upload className="size-3.5" />
            <span className="flex-1">上传</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="browser"
            onSelect={onOpenBrowserTab}
          >
            <Globe className="size-3.5" />
            <span className="flex-1">新建浏览器</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            data-open-design-add="design-system"
            onSelect={onCreateDesignSystem}
          >
            <Palette className="size-3.5" />
            <span className="flex-1">新建设计体系</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {markdownMode ? null : (
        <ToolbarIconButton
          label="刷新"
          disabled={busy || !hasCanvas}
          onClick={onRefresh}
        >
          <RefreshCw className="size-3" />
        </ToolbarIconButton>
      )}
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
      {markdownMode ? null : (
        <>
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
                <span className="text-ui-caption leading-none">
                  {commentCount}
                </span>
              ) : null}
            </ToolbarIconButton>
            <ToolbarToggleIconButton
              label="标注"
              active={tool === "annotate" && annotationKind === "pen"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => {
                onAnnotationKind("pen");
                onTool(
                  tool === "annotate" && annotationKind === "pen"
                    ? "none"
                    : "annotate",
                );
              }}
            >
              <Highlighter className="size-3" />
            </ToolbarToggleIconButton>
            <ToolbarToggleIconButton
              label="框选"
              active={tool === "annotate" && annotationKind === "rect"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => {
                onAnnotationKind("rect");
                onTool(
                  tool === "annotate" && annotationKind === "rect"
                    ? "none"
                    : "annotate",
                );
              }}
            >
              <SquareDashed className="size-3" />
            </ToolbarToggleIconButton>
            <ToolbarToggleIconButton
              label="文本"
              active={tool === "annotate" && annotationKind === "text"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => {
                onAnnotationKind("text");
                onTool(
                  tool === "annotate" && annotationKind === "text"
                    ? "none"
                    : "annotate",
                );
              }}
            >
              <Type className="size-3" />
            </ToolbarToggleIconButton>
            <ToolbarToggleIconButton
              label="标记"
              active={tool === "annotate" && annotationKind === "mark"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => {
                onAnnotationKind("mark");
                onTool(
                  tool === "annotate" && annotationKind === "mark"
                    ? "none"
                    : "annotate",
                );
              }}
            >
              <MapPin className="size-3" />
            </ToolbarToggleIconButton>
            <ToolbarToggleIconButton
              label="批注选择"
              active={tool === "adjust"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => onTool(tool === "adjust" ? "none" : "adjust")}
            >
              <MousePointer2 className="size-3" />
            </ToolbarToggleIconButton>
            <ToolbarToggleIconButton
              label="橡皮擦"
              active={tool === "erase"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => onTool(tool === "erase" ? "none" : "erase")}
            >
              <Eraser className="size-3" />
            </ToolbarToggleIconButton>
            <ToolbarToggleIconButton
              label="元素选择"
              active={tool === "element"}
              disabled={busy || !hasCanvas || viewMode === "code"}
              onClick={() => onTool(tool === "element" ? "none" : "element")}
            >
              <SquareMousePointer className="size-3" />
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
              label={
                activeDesignSystemTitle
                  ? `设计体系：${activeDesignSystemTitle}`
                  : "设计体系"
              }
              disabled={busy}
              onClick={onOpenDesignSystems}
            >
              <Palette className="size-3" />
            </ToolbarIconButton>
          </div>
        </>
      )}
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
