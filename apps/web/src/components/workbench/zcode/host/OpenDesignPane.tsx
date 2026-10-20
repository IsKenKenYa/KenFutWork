import {
  Camera,
  Download,
  ExternalLink,
  Link2,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ControlHintTooltip } from "@zui/ControlHintTooltip.js";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { dispatchOpenDesignCanvasAddToChat } from "@zui/lib/openDesignCanvasChat.js";
import type { OpenDesignSidePaneMetadata } from "@zui/lib/workspaceSidePane.js";
import {
  ZCodeStartupLogoBadge,
  ZCodeStartupSpinner,
} from "@zui/root/RootStartupLoading.js";
import { rasterizeDesignHtml } from "./openDesignCapture.js";
import { useOpenDesignEntry } from "./openDesignHost.js";
import { surfaceJson } from "./surfaceApi.js";

/**
 * OpenDesign 画布面板（一块画布一个标签，与浏览器面板同位互斥）。
 *
 * 嵌的是上游**预览路由**（`/api/projects/:id/preview/<token>/<file>`，纯文件、无应用外壳）：
 * 上游没有 canvas-only 路由，早先「2 倍宽裁掉聊天栏」的折衷随本改造退役。项目名映射到
 * 侧栏标签标题（`onMeta` 回写），工具栏是本仓口径的：刷新 / 截图到对话 / 导出图片 /
 * 复制链接 / 在 OpenDesign 打开 / 缩放。上游应用级能力（分享弹窗、评论、代码视图、
 * 设备框）不在推理范围内，走「在 OpenDesign 打开」的完整工作区。
 *
 * 我们的工具栏按钮一律走宿主路由（`/api/open-design/host/*`）；浏览器直连 daemon
 * 会撞 CORS（预检 403），预览 iframe 是唯一的直连例外（只读公开地址）。
 */
export function OpenDesignPane({
  tabId,
  projectId,
  onMeta,
  workspacePath,
  workspaceIdentity,
}: {
  /** 侧栏标签 id：画布名/绑定回写按它记账。 */
  tabId: string;
  /** 绑定的画布（上游项目 id）；null = 未绑定，面板解析「最近画布」。 */
  projectId: string | null;
  onMeta: (tabId: string, metadata: OpenDesignSidePaneMetadata) => void;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const entry = useOpenDesignEntry();
  const entryAvailable = entry?.available === true;
  const [boundProjectId, setBoundProjectId] = useState<string | null>(projectId);
  const [canvas, setCanvas] = useState<{
    projectId: string;
    name: string;
    entryFile: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    iframeSandbox: string;
  } | null>(null);
  const [phase, setPhase] = useState<
    "loading" | "ready" | "empty" | "no-file" | "error"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<number>(100);
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const reportedRef = useRef("");
  /**
   * 上游就绪状态：没有可用 agent CLI 时，生成永远出不来。
   * 这条探针让面板自己说明原因，而不是让用户对着空白画布猜。
   */
  const [readiness, setReadiness] = useState<{
    reachable: boolean;
    agentAvailable: boolean;
  } | null>(null);

  const reportMeta = useCallback(
    (metadata: OpenDesignSidePaneMetadata) => {
      const key = JSON.stringify(metadata);
      if (reportedRef.current === key) return;
      reportedRef.current = key;
      onMeta(tabId, metadata);
    },
    [onMeta, tabId],
  );

  useEffect(() => {
    let cancelled = false;
    void surfaceJson<{ reachable: boolean; agentAvailable: boolean }>(
      "/api/open-design/host/readiness",
    )
      .then((value) => {
        if (!cancelled) setReadiness(value);
      })
      .catch(() => {
        // 探针失败不挡画布
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 绑定：标签带 projectId 就用它；没带（旧状态）退回「最近画布」，一个都没有则空态。
  useEffect(() => {
    if (projectId) {
      setBoundProjectId(projectId);
      return;
    }
    let cancelled = false;
    void surfaceJson<{ project?: { projectId?: string; name?: string } }>(
      "/api/open-design/last-project",
    )
      .then((data) => {
        if (cancelled) return;
        const adopted = data?.project?.projectId;
        if (!adopted) {
          setPhase("empty");
          return;
        }
        setBoundProjectId(adopted);
        reportMeta({ projectId: adopted, title: data?.project?.name ?? null });
      })
      .catch(() => {
        if (!cancelled) setPhase("empty");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reportMeta]);

  const loadCanvas = useCallback(
    async (id: string): Promise<string | null> => {
      setPhase("loading");
      setError(null);
      try {
        const data = await surfaceJson<{
          project: { projectId: string; name: string };
          entryFile: string | null;
        }>(`/api/open-design/host/canvas/${encodeURIComponent(id)}`);
        setCanvas({
          projectId: data.project.projectId,
          name: data.project.name,
          entryFile: data.entryFile,
        });
        reportMeta({ title: data.project.name });
        setPhase(data.entryFile ? "loading" : "no-file");
        return data.entryFile;
      } catch (loadError) {
        setPhase("error");
        setError(
          loadError instanceof Error ? loadError.message : "读取画布失败。",
        );
        return null;
      }
    },
    [reportMeta],
  );

  const loadPreview = useCallback(
    async (id: string, file: string): Promise<boolean> => {
      try {
        const info = await surfaceJson<{ url: string; iframeSandbox: string }>(
          `/api/open-design/host/preview-url?projectId=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`,
        );
        setPreview(info);
        setFrameLoaded(false);
        setFrameKey((key) => key + 1);
        setPhase("ready");
        return true;
      } catch (loadError) {
        setPhase("error");
        setError(
          loadError instanceof Error ? loadError.message : "打开画布失败。",
        );
        return false;
      }
    },
    [],
  );

  useEffect(() => {
    if (!boundProjectId || !entryAvailable) return;
    let cancelled = false;
    void (async () => {
      const file = await loadCanvas(boundProjectId);
      if (cancelled || !file) return;
      await loadPreview(boundProjectId, file);
    })();
    return () => {
      cancelled = true;
    };
  }, [boundProjectId, entryAvailable, loadCanvas, loadPreview]);

  const refresh = useCallback(async () => {
    if (!boundProjectId) return;
    setBusy(true);
    setNotice(null);
    const file = await loadCanvas(boundProjectId);
    if (file) await loadPreview(boundProjectId, file);
    setBusy(false);
  }, [boundProjectId, loadCanvas, loadPreview]);

  const createCanvas = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const created = await surfaceJson<{
        project: { projectId: string; name: string };
      }>("/api/open-design/host/canvas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      setCanvas(null);
      setPreview(null);
      setBoundProjectId(created.project.projectId);
      reportMeta({
        projectId: created.project.projectId,
        title: created.project.name,
      });
    } catch (createError) {
      setNotice(
        createError instanceof Error ? createError.message : "新建画布失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [reportMeta]);

  /** 截图输入 = 设计文件文本 + 画布可视尺寸（光栅化在浏览器里做）。 */
  const capturePng = useCallback(async (): Promise<string | null> => {
    if (!canvas?.entryFile) {
      setNotice("画布还没有内容");
      return null;
    }
    const text = await surfaceJson<{ text: string }>(
      `/api/open-design/host/file-text?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}`,
    );
    const box = frameWrapRef.current;
    const width = Math.max(
      CAPTURE_MIN_SIDE,
      Math.round(box?.clientWidth ?? CAPTURE_FALLBACK_SIZE.width),
    );
    const height = Math.max(
      CAPTURE_MIN_SIDE,
      Math.round(box?.clientHeight ?? CAPTURE_FALLBACK_SIZE.height),
    );
    return rasterizeDesignHtml(text.text, width, height);
  }, [canvas]);

  const addToChat = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      const name = `${(canvas?.name ?? "画布").replace(UNSAFE_FILENAME_CHARS, "-")}.png`;
      const file = new File([blob], name, { type: "image/png" });
      const delivered = dispatchOpenDesignCanvasAddToChat({
        projectId: canvas?.projectId ?? boundProjectId ?? "",
        title: canvas?.name ?? null,
        file,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!delivered) setNotice("先点一下对话输入框");
    } catch (captureError) {
      setNotice(
        captureError instanceof Error ? captureError.message : "截图失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [
    boundProjectId,
    canvas,
    capturePng,
    workspaceIdentity,
    workspacePath,
  ]);

  const exportPng = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${(canvas?.name ?? "画布").replace(UNSAFE_FILENAME_CHARS, "-")}.png`;
      anchor.click();
    } catch (captureError) {
      setNotice(
        captureError instanceof Error ? captureError.message : "导出失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [canvas, capturePng]);

  const copyLink = useCallback(async () => {
    if (!entryAvailable || !boundProjectId) return;
    setNotice(null);
    try {
      await navigator.clipboard.writeText(
        `${entry.frontendUrl.replace(/\/$/u, "")}/projects/${boundProjectId}`,
      );
      setNotice("已复制链接");
    } catch {
      setNotice("复制失败");
    }
  }, [boundProjectId, entry, entryAvailable]);

  const openInOpenDesign = useCallback(() => {
    if (!entryAvailable || !boundProjectId) return;
    window.open(
      `${entry.frontendUrl.replace(/\/$/u, "")}/projects/${boundProjectId}`,
      "_blank",
      "noopener",
    );
  }, [boundProjectId, entry, entryAvailable]);

  if (entry === null) {
    return (
      <div
        data-testid="open-design-pane"
        className="flex h-full flex-col items-center justify-center gap-5 bg-background"
      >
        <ZCodeStartupLogoBadge />
        <ZCodeStartupSpinner />
      </div>
    );
  }

  if (!entryAvailable) {
    return (
      <div
        data-testid="open-design-pane"
        className="flex h-full items-center justify-center bg-background px-6 text-center text-xs text-foreground-subtle"
      >
        {entry.reason}
      </div>
    );
  }

  const scale = zoom / 100;
  const captureReady = phase === "ready" && Boolean(canvas?.entryFile);

  return (
    <div
      data-testid="open-design-pane"
      className="flex h-full w-full flex-col bg-background"
    >
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1.5 py-1">
        <ToolbarIconButton
          label="刷新"
          disabled={busy || !canvas}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="截图到对话"
          disabled={busy || !captureReady}
          onClick={() => void addToChat()}
        >
          <Camera className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="导出图片"
          disabled={busy || !captureReady}
          onClick={() => void exportPng()}
        >
          <Download className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="复制链接"
          disabled={!boundProjectId}
          onClick={() => void copyLink()}
        >
          <Link2 className="size-3" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label="在 OpenDesign 打开"
          disabled={!boundProjectId}
          onClick={openInOpenDesign}
        >
          <ExternalLink className="size-3" />
        </ToolbarIconButton>
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-foreground-subtle"
                aria-label="缩放"
              >
                {zoom}%
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ZOOM_LEVELS.map((level) => (
                <DropdownMenuItem key={level} onSelect={() => setZoom(level)}>
                  {level}%
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {readiness?.reachable && !readiness.agentAvailable ? (
        <div
          role="status"
          data-testid="open-design-readiness"
          className="shrink-0 border-b border-border px-3 py-2 text-ui-caption text-foreground-subtle"
        >
          没有可用的设计引擎
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          data-testid="open-design-notice"
          className="shrink-0 border-b border-border px-3 py-1 text-ui-caption text-foreground-subtle"
        >
          {notice}
        </div>
      ) : null}
      <div
        ref={frameWrapRef}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        {phase === "ready" && preview && canvas?.entryFile ? (
          <>
            <iframe
              key={frameKey}
              src={`${entry.frontendUrl.replace(/\/$/u, "")}${preview.url}`}
              title="OpenDesign"
              sandbox={preview.iframeSandbox}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: `${100 / scale}%`,
                height: `${100 / scale}%`,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
              className={`border-0 bg-white transition-opacity duration-300 ${
                frameLoaded ? "opacity-100" : "opacity-0"
              }`}
              onLoad={() => setFrameLoaded(true)}
            />
            {!frameLoaded ? (
              <div
                role="status"
                className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background"
              >
                <ZCodeStartupLogoBadge />
                <ZCodeStartupSpinner />
              </div>
            ) : null}
          </>
        ) : null}
        {phase === "empty" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-foreground-subtle">
            <span>还没有画布</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void createCanvas()}
            >
              新建画布
            </Button>
          </div>
        ) : null}
        {phase === "no-file" ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-foreground-subtle">
            画布还没有内容
          </div>
        ) : null}
        {phase === "error" ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-foreground-subtle">
            {error}
          </div>
        ) : null}
        {phase === "loading" && !canvas ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background"
          >
            <ZCodeStartupLogoBadge />
            <ZCodeStartupSpinner />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 工具栏缩放档位（与上游 100% 同口径，只做预览缩放，不改设计本身）。 */
const ZOOM_LEVELS = [50, 75, 100, 125, 150] as const;

/** 容器还没量到尺寸时的截图兜底（面板刚挂载就点截图）。 */
const CAPTURE_FALLBACK_SIZE = { width: 960, height: 640 } as const;
const CAPTURE_MIN_SIDE = 240;

/** 文件名里不能出现的字符（不同文件系统共同禁集，粗收敛即可）。 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

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