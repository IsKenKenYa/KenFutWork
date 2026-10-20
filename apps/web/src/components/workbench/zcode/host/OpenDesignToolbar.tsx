import {
  Camera,
  Check,
  Code2,
  Download,
  Eye,
  FolderInput,
  History,
  Monitor,
  RefreshCw,
  Share2,
  Smartphone,
  Tablet,
} from "lucide-react";
import type { ReactNode } from "react";
import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";

/**
 * 画布工具栏（本仓口径，替代上游 FileViewer 那两行 chrome）。
 *
 * 上游控件逐项映射见台账 §二百〇四：刷新 / 预览·代码 / 设备视口 / 截图到对话 /
 * 交给对话（上游 Handoff 的文件夹按钮）/ 历史记录 / 导出 / 分享 / 缩放。
 * 上游的画布评论、标注、可视化编辑需要它自己的应用内运行时，纯预览嵌入承载不了，
 * 不在这里摆假开关。
 */
export type OpenDesignViewMode = "preview" | "code";
export type OpenDesignViewport = "desktop" | "tablet" | "mobile";

export interface OpenDesignVersionSummary {
  id: string;
  label: string;
  version: number;
  createdAt: number;
  current: boolean;
}

export const OPEN_DESIGN_ZOOM_LEVELS = [50, 75, 100, 125, 150, 200] as const;

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
}: {
  busy: boolean;
  hasCanvas: boolean;
  viewMode: OpenDesignViewMode;
  onViewMode: (mode: OpenDesignViewMode) => void;
  viewport: OpenDesignViewport;
  onViewport: (viewport: OpenDesignViewport) => void;
  zoom: number;
  onZoom: (zoom: number) => void;
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
}) {
  const activeViewport = VIEWPORTS.find((item) => item.id === viewport);
  const ViewportIcon = activeViewport?.icon ?? Monitor;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
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
            <DropdownMenuItem key={item.id} onSelect={() => onViewport(item.id)}>
              <item.icon className="size-3.5" />
              <span className="flex-1">{item.label}</span>
              {viewport === item.id ? <Check className="size-3.5" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex flex-wrap items-center gap-0.5">
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
            <DropdownMenuItem onSelect={onExportHtml}>HTML 文件</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ToolbarIconButton
          label="分享"
          disabled={!hasCanvas}
          onClick={onShare}
        >
          <Share2 className="size-3" />
        </ToolbarIconButton>
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

function formatVersionTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const date = new Date(timestamp);
  return `${date.toLocaleDateString("zh-CN")} ${date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
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
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="text-foreground-subtle hover:text-foreground"
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}