import type {
  DesignReviewAnnotation,
  DesignReviewComment,
} from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@zui/components/ui/dropdown-menu.js";
import { toast } from "@zui/components/ui/toast.js";
import { requestCanvasDocumentOpen } from "@zui/host/conversationWorkContext.js";
import { dispatchOpenDesignCanvasAddToChat } from "@zui/lib/openDesignCanvasChat.js";
import type { OpenDesignSidePaneMetadata } from "@zui/lib/workspaceSidePane.js";
import {
  ZCodeStartupLogoBadge,
  ZCodeStartupSpinner,
} from "@zui/root/RootStartupLoading.js";
import {
  ArrowLeft,
  Copy,
  FileText,
  Globe,
  MoreHorizontal,
  Palette,
  Pencil,
  PenTool,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OpenDesignCommentComposer,
  OpenDesignCommentSidebar,
} from "./OpenDesignCommentSidebar.js";
import {
  type OpenDesignEditDraft,
  OpenDesignEditInspector,
} from "./OpenDesignEditInspector.js";
import { OpenDesignMarkup } from "./OpenDesignMarkup.js";
import {
  OpenDesignDeleteDialog,
  OpenDesignRenameDialog,
} from "./openDesignFileDialogs.js";
import {
  FigmaMark,
  type OpenDesignTool,
  OpenDesignToolbar,
  type OpenDesignVersionSummary,
  type OpenDesignViewMode,
  type OpenDesignViewport,
} from "./OpenDesignToolbar.js";
import { rasterizeDesignHtml } from "./openDesignCapture.js";
import { useOpenDesignEntry } from "./openDesignHost.js";
import { OpenDesignMarkdownPreview } from "./openDesignMarkdownPreview.js";
import type { OverlayBox } from "./openDesignMarkupGeometry.js";
import {
  buildCanvasDocument,
  type OpenDesignHit,
} from "./openDesignRuntime.js";
import {
  applyElementEdit,
  moveElement,
  type OpenDesignMovePosition,
} from "./openDesignSourceEdit.js";
import { surfaceJson, surfaceRequest } from "./surfaceApi.js";
import { useOpenDesignBridge } from "./useOpenDesignBridge.js";

/** 文档标题取第一个一级标题；没有就回退文件名。 */
function markdownTitle(text: string): string | null {
  return /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() || null;
}

/** 资源标签名：草图/文档/设计用中文，其他用去扩展名的文件名。 */
function resourceTitle(name: string): string {
  const base = name.split("/").pop() ?? name;
  if (/\.sketch\.json$/iu.test(base)) return "草图";
  if (/\.md$/iu.test(base))
    return /^document[-_]/iu.test(base) ? "文档" : base.replace(/\.md$/iu, "");
  if (/^index\.html?$/iu.test(base)) return "设计";
  return base.replace(/\.(?:html?|png|jpe?g|svg|webp|json|txt)$/iu, "");
}

/** 用户口径：OpenDesign 的提示一律走页面顶部 toast（3s 自动消失），不摆常驻状态条。 */
function notify(message: string | null) {
  if (message) toast(message, { dedupeKey: message });
}

/**
 * OpenDesign 画布面板（一块画布一个标签，与浏览器面板同位互斥）。
 *
 * 嵌上游**预览路由**（`/api/projects/:id/preview/<token>/<file>`，纯文件、无应用外壳）。
 * 工具栏逐项对应上游 FileViewer（见台账 §二百〇四）：刷新 / 预览·代码 / 设备视口 /
 * 截图到对话 / 交给对话 / 历史记录 / 导出（PNG、HTML）/ 分享（复制本机链接）/ 缩放。
 * 上游画布评论、标注、可视化编辑依赖它自己的应用内运行时，纯预览嵌入不承载。
 */
export function OpenDesignPane({
  tabId,
  projectId,
  workspaceProjectId = null,
  workspaceName,
  onMeta,
  workspacePath,
  workspaceIdentity,
  onOpenBrowserTab,
}: {
  /** 侧栏标签 id：画布名/绑定回写按它记账。 */
  tabId: string;
  /** 显式绑定的设计项目（agent/深链）；null = 按当前项目取/建。 */
  projectId: string | null;
  /** 当前 KenFutWork 项目 id：草图列表与草图创建走它。 */
  workspaceProjectId?: string | null;
  /** 侧栏标签默认标题（当前项目名）。 */
  workspaceName?: string | null;
  onMeta: (tabId: string, metadata: OpenDesignSidePaneMetadata) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 「+」里的「新建浏览器」：开侧栏浏览器标签（与画布标签同位）。 */
  onOpenBrowserTab: () => void;
}) {
  const entry = useOpenDesignEntry();
  const entryAvailable = entry?.available === true;
  const [boundProjectId, setBoundProjectId] = useState<string | null>(
    projectId,
  );
  const [canvas, setCanvas] = useState<{
    projectId: string;
    name: string;
    entryFile: string | null;
    designSystemId: string | null;
  } | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    iframeSandbox: string;
  } | null>(null);
  const [phase, setPhase] = useState<
    "loading" | "ready" | "empty" | "no-file" | "error"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewMode, setViewMode] = useState<OpenDesignViewMode>("preview");
  const [viewport, setViewport] = useState<OpenDesignViewport>("desktop");
  const [zoom, setZoom] = useState<number>(100);
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [currentText, setCurrentText] = useState<string | null>(null);
  const [markdownDraft, setMarkdownDraft] = useState<string | null>(null);
  const [markdownDirty, setMarkdownDirty] = useState(false);
  const [markdownSaving, setMarkdownSaving] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<string | null>(null);
  const [sourceDirty, setSourceDirty] = useState(false);
  const [sourceSaving, setSourceSaving] = useState(false);
  const sourceFileRef = useRef<string | null>(null);
  const [renamingFile, setRenamingFile] = useState<{
    name: string;
    draft: string;
  } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [copyingFile, setCopyingFile] = useState<string | null>(null);
  const [versions, setVersions] = useState<OpenDesignVersionSummary[] | null>(
    null,
  );
  const [files, setFiles] = useState<Array<{ name: string; kind: string }>>([]);
  const [sketches, setSketches] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  /** 默认停在项目资源页；打开某个资源后才切到预览。 */
  const [resourceView, setResourceView] = useState(true);
  /** 草图/文档等非 HTML 资源用上游预览页直出，不走 srcdoc 注入。 */
  const [directPreview, setDirectPreview] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(false);
  const [activeVersion, setActiveVersion] = useState<{
    id: string;
    label: string;
    text: string;
  } | null>(null);
  const frameWrapRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const reportedRef = useRef("");
  /**
   * 上游就绪状态：没有可用 agent CLI 时，生成永远出不来。
   * 这条探针让面板自己说明原因，而不是让用户对着空白画布猜。
   */
  const [readiness, setReadiness] = useState<{
    reachable: boolean;
    agentAvailable: boolean;
  } | null>(null);
  /** 画布上的工作模式（评论/标注/编辑互斥）与拾取到的元素。 */
  const [tool, setTool] = useState<OpenDesignTool>("none");
  const [annotationKind, setAnnotationKind] = useState<
    "pen" | "rect" | "text" | "mark"
  >("pen");
  const [picked, setPicked] = useState<OpenDesignHit | null>(null);
  const [pendingComment, setPendingComment] = useState<OpenDesignHit | null>(
    null,
  );
  const [review, setReview] = useState<{
    annotations: DesignReviewAnnotation[];
    comments: DesignReviewComment[];
  }>({ annotations: [], comments: [] });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  /** iframe 元素在覆盖层坐标系里的盒子（换算图钉与笔迹落点要用）。 */
  const [overlayBox, setOverlayBox] = useState<OverlayBox | null>(null);

  /**
   * 渲染文档：正文 + `<base>`（相对资源落回上游预览目录）+ 桥脚本。
   * DOMParser 一遍不便宜，只在正文或基准地址真的换了时重算。
   */
  const activeText = activeVersion?.text ?? currentText;
  const assetBaseUrl =
    preview && entryAvailable
      ? `${entry.frontendUrl.replace(/\/$/u, "")}${preview.url}`.replace(
          /[^/]*$/u,
          "",
        )
      : null;
  const directPreviewSrc =
    preview && entryAvailable
      ? `${entry.frontendUrl.replace(/\/$/u, "")}${preview.url}`
      : null;
  const documentHtml = useMemo(() => {
    if (!activeText || !assetBaseUrl) return null;
    return buildCanvasDocument(activeText, assetBaseUrl);
  }, [activeText, assetBaseUrl]);
  const documentKey = `${activeVersion?.id ?? "current"}:${frameKey}:${
    canvas?.entryFile ?? ""
  }:${documentHtml ? "doc" : "pending"}`;

  const onPickHit = useCallback((hit: OpenDesignHit) => {
    // 评论与编辑共用一次拾取，落点不同：评论进落笔卡片，编辑进检视器。
    setTool("none");
    setPicked(hit);
  }, []);
  const onCommentHit = useCallback((hit: OpenDesignHit) => {
    setTool("none");
    setPendingComment(hit);
  }, []);
  const trackedPaths = useMemo(
    () =>
      review.comments
        .filter((comment) => comment.status === "open")
        .map((comment) => comment.anchor.path),
    [review.comments],
  );
  const {
    ready: bridgeReady,
    rects,
    docSize,
    setPicking,
    hitTest,
  } = useOpenDesignBridge({
    frameRef,
    documentKey,
    trackedPaths,
    onPickHit: (hit) => {
      if (pendingComment || tool === "comment") onCommentHit(hit);
      else onPickHit(hit);
    },
  });

  // 桥的重渲染会把它自己的 picking 态清掉，因此换文档后也要按当前模式重发一次。
  useEffect(() => {
    if (!bridgeReady) return;
    setPicking(tool === "edit" || tool === "comment");
  }, [bridgeReady, documentKey, setPicking, tool]);

  // 覆盖层坐标系：以滚动容器左上角为原点，iframe 元素盒子换成相对坐标。
  // 量到 0 也照记（首帧未布局、jsdom 无布局），下一次桥回传矩形时会再量一遍。
  useEffect(() => {
    const wrap = frameWrapRef.current;
    const frame = frameRef.current;
    if (!wrap || !frame) return;
    const wr = wrap.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    setOverlayBox({
      left: fr.left - wr.left + wrap.scrollLeft,
      top: fr.top - wr.top + wrap.scrollTop,
      width: fr.width,
      height: fr.height,
    });
  }, [docSize, documentKey, frameLoaded, overlayBox?.width, rects, zoom]);

  /** 评论与标注：一块画布的一个文件一份清单。 */
  const loadReview = useCallback(async () => {
    if (!canvas?.entryFile) return;
    try {
      const data = await surfaceJson<{
        annotations: DesignReviewAnnotation[];
        comments: DesignReviewComment[];
      }>(
        `/api/design-review?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}`,
      );
      setReview(data);
    } catch {
      // 读不到评审数据不挡画布：图钉与笔迹只是不显示。
    }
  }, [canvas]);

  useEffect(() => {
    if (phase !== "ready" || !canvas?.entryFile) return;
    void loadReview();
  }, [canvas?.entryFile, loadReview, phase]);

  const createComment = useCallback(
    async (body: string) => {
      if (!pendingComment || !canvas?.entryFile || !docSize) return;
      setBusy(true);
      notify(null);
      try {
        const data = await surfaceJson<{ comment: DesignReviewComment }>(
          "/api/design-review/comments",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              projectId: canvas.projectId,
              file: canvas.entryFile,
              body,
              // 锚点矩形存文档坐标：滚动之后仍能折算回屏幕位置。
              anchor: {
                path: pendingComment.path,
                rect: {
                  x: pendingComment.rect.x + docSize.sx,
                  y: pendingComment.rect.y + docSize.sy,
                  w: pendingComment.rect.w,
                  h: pendingComment.rect.h,
                },
                excerpt: pendingComment.text.slice(0, 120),
              },
            }),
          },
        );
        setReview((current) => ({
          ...current,
          comments: [...current.comments, data.comment],
        }));
        setPendingComment(null);
        setSidebarOpen(true);
      } catch (createError) {
        notify(
          createError instanceof Error ? createError.message : "评论失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [canvas, docSize, pendingComment],
  );

  const patchComment = useCallback(
    async (comment: DesignReviewComment, patch: { status?: string }) => {
      setBusy(true);
      try {
        const data = await surfaceJson<{ comment: DesignReviewComment }>(
          `/api/design-review/comments/${encodeURIComponent(comment.id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          },
        );
        setReview((current) => ({
          ...current,
          comments: current.comments.map((item) =>
            item.id === data.comment.id ? data.comment : item,
          ),
        }));
      } catch (patchError) {
        notify(
          patchError instanceof Error ? patchError.message : "改动评论失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const removeComment = useCallback(async (comment: DesignReviewComment) => {
    setBusy(true);
    try {
      await surfaceJson(
        `/api/design-review/comments/${encodeURIComponent(comment.id)}`,
        { method: "DELETE" },
      );
      setReview((current) => ({
        ...current,
        comments: current.comments.filter((item) => item.id !== comment.id),
      }));
    } finally {
      setBusy(false);
    }
  }, []);

  const createAnnotation = useCallback(
    async (draft: {
      kind: "pen" | "rect" | "text" | "mark";
      points: [number, number][];
      text?: string;
    }) => {
      if (!canvas?.entryFile) return;
      try {
        const data = await surfaceJson<{
          annotation: DesignReviewAnnotation;
        }>("/api/design-review/annotations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: canvas.projectId,
            file: canvas.entryFile,
            kind: draft.kind,
            ...(draft.text ? { text: draft.text } : {}),
            color: ANNOTATION_COLOR,
            strokeWidth: 3,
            points: draft.points,
          }),
        });
        setReview((current) => ({
          ...current,
          annotations: [...current.annotations, data.annotation],
        }));
      } catch (drawError) {
        notify(
          drawError instanceof Error ? drawError.message : "保存标注失败。",
        );
      }
    },
    [canvas],
  );

  /** 元素选择拖放：在源文本里换容器/改顺序，再经宿主写回并重渲染。 */
  const moveElementTo = useCallback(
    async (
      path: string,
      targetPath: string,
      position: OpenDesignMovePosition,
    ) => {
      if (!boundProjectId || !canvas?.entryFile || currentText === null) {
        return;
      }
      const next = moveElement(currentText, path, targetPath, position);
      if (next === null) {
        notify("这个元素在当前正文里找不到，没有移动。");
        return;
      }
      try {
        await surfaceJson("/api/open-design/host/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: boundProjectId,
            name: canvas.entryFile,
            content: next,
            encoding: "utf8",
            versionLabel: "移动元素",
          }),
        });
        setCurrentText(next);
        setSourceDraft(next);
        setSourceDirty(false);
        setFrameKey((key) => key + 1);
        notify("已移动");
      } catch (moveError) {
        notify(
          moveError instanceof Error ? moveError.message : "移动失败。",
        );
      }
    },
    [boundProjectId, canvas?.entryFile, currentText],
  );

  /** 批注选择工具：移动/缩放后写回点集（归一化坐标）。 */
  const updateAnnotation = useCallback(
    async (id: string, points: [number, number][]) => {
      try {
        const data = await surfaceJson<{
          annotation: DesignReviewAnnotation;
        }>(`/api/design-review/annotations/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ points }),
        });
        setReview((current) => ({
          ...current,
          annotations: current.annotations.map((item) =>
            item.id === data.annotation.id ? data.annotation : item,
          ),
        }));
      } catch (moveError) {
        notify(
          moveError instanceof Error ? moveError.message : "移动标注失败。",
        );
      }
    },
    [],
  );

  const removeAnnotation = useCallback(async (id: string) => {
    try {
      await surfaceJson(
        `/api/design-review/annotations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      setReview((current) => ({
        ...current,
        annotations: current.annotations.filter((item) => item.id !== id),
      }));
    } catch (eraseError) {
      notify(
        eraseError instanceof Error ? eraseError.message : "删除标注失败。",
      );
    }
  }, []);

  const reportMeta = useCallback(
    (metadata: OpenDesignSidePaneMetadata) => {
      const key = JSON.stringify(metadata);
      if (reportedRef.current === key) return;
      reportedRef.current = key;
      onMeta(tabId, metadata);
    },
    [onMeta, tabId],
  );

  const loadPreview = useCallback(
    async (id: string, file: string): Promise<boolean> => {
      try {
        const info = await surfaceJson<{ url: string; iframeSandbox: string }>(
          `/api/open-design/host/preview-url?projectId=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`,
        );
        setPreview(info);
        setDirectPreview(!/\.html?$/iu.test(file) && !/\.md$/iu.test(file));
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

  const workspaceKey = workspaceIdentity?.trim() || workspacePath;

  const loadSketches = useCallback(async () => {
    if (!workspaceProjectId) {
      setSketches([]);
      return;
    }
    try {
      const data = await surfaceJson<{
        canvases: Array<{ id: string; name: string }>;
      }>(`/api/projects/${encodeURIComponent(workspaceProjectId)}/canvases`);
      setSketches(
        data.canvases.map((canvas) => ({ id: canvas.id, name: canvas.name })),
      );
    } catch {
      // 草图列表读不到不挡设计资源；资源页仍可用。
      setSketches([]);
    }
  }, [workspaceProjectId]);

  // 绑定：默认按当前项目取/建项目资源；显式 projectId（agent/深链）优先。
  useEffect(() => {
    if (!entryAvailable) return;
    let cancelled = false;
    setPhase("loading");
    setError(null);
    void (async () => {
      try {
        // 沙箱任务的 workspaceAbsPath 末段是 taskId，不是项目名；项目名以宿主目录为准。
        let resolvedName = workspaceName?.trim() ?? "";
        if (!projectId && workspaceProjectId) {
          try {
            const catalog = await surfaceJson<{
              workspaces: Array<{ projectId: string; name: string }>;
            }>("/api/code-ui/workspaces");
            const found = catalog.workspaces.find(
              (workspace) => workspace.projectId === workspaceProjectId,
            );
            if (found?.name.trim()) resolvedName = found.name.trim();
          } catch {
            // 目录读不到就退回传入名；不挡资源页。
          }
        }
        const data = projectId
          ? await surfaceJson<{
              project: {
                projectId: string;
                name: string;
                designSystemId?: string | null;
              };
              entryFile: string | null;
              files: Array<{ name: string; kind: string }>;
            }>(`/api/open-design/host/canvas/${encodeURIComponent(projectId)}`)
          : workspaceProjectId
            ? await surfaceJson<{
                project: {
                  projectId: string;
                  name: string;
                  designSystemId?: string | null;
                };
                entryFile: string | null;
                files: Array<{ name: string; kind: string }>;
                created: boolean;
              }>("/api/open-design/host/workspace-project", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  workspaceKey,
                  ...(resolvedName ? { name: resolvedName } : {}),
                }),
              })
            : null;
        if (cancelled) return;
        if (!data) {
          setPhase("empty");
          setResourceView(true);
          return;
        }
        const entryFile = projectId ? (data.entryFile ?? null) : null;
        setBoundProjectId(data.project.projectId);
        setCanvas({
          projectId: data.project.projectId,
          name: data.project.name,
          entryFile,
          designSystemId: data.project.designSystemId ?? null,
        });
        setFiles(data.files ?? []);
        setPhase("ready");
        if (entryFile) {
          // 显式 projectId（agent/深链）仍直接打开设计文件；默认项目入口停在资源页。
          setResourceView(false);
          await loadPreview(data.project.projectId, entryFile);
        } else {
          setResourceView(true);
          setDirectPreview(false);
        }
        reportMeta({
          title: projectId
            ? data.project.name
            : resolvedName || data.project.name,
        });
      } catch (bindError) {
        if (cancelled) return;
        setPhase("error");
        setError(
          bindError instanceof Error ? bindError.message : "读取项目资源失败。",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    entryAvailable,
    projectId,
    workspaceProjectId,
    workspaceKey,
    workspaceName,
    reportMeta,
    loadPreview,
  ]);

  useEffect(() => {
    if (entryAvailable) void loadSketches();
  }, [entryAvailable, loadSketches]);

  const loadCurrentText = useCallback(async (): Promise<string | null> => {
    if (!canvas?.entryFile) return null;
    try {
      const data = await surfaceJson<{ text: string }>(
        `/api/open-design/host/file-text?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}`,
      );
      setCurrentText(data.text);
      if (/\.md$/iu.test(canvas.entryFile)) {
        const title = markdownTitle(data.text);
        if (title) reportMeta({ title });
      }
      return data.text;
    } catch (loadError) {
      notify(
        loadError instanceof Error ? loadError.message : "读取设计文件失败。",
      );
      return null;
    }
  }, [canvas, reportMeta]);

  // 正文是画布的唯一真相：预览（注入后 srcdoc）、代码视图、截图/导出、编辑保存
  // 全都吃这一份，因此画布就绪就取一次，不再按视图惰性加载。
  useEffect(() => {
    if (activeVersion || currentText !== null) return;
    if (!canvas?.entryFile) return;
    void loadCurrentText();
  }, [activeVersion, canvas?.entryFile, currentText, loadCurrentText]);

  const refresh = useCallback(async () => {
    if (!boundProjectId) return;
    setBusy(true);
    notify(null);
    try {
      const data = await surfaceJson<{
        project: {
          projectId: string;
          name: string;
          designSystemId?: string | null;
        };
        files: Array<{ name: string; kind: string }>;
      }>(`/api/open-design/host/canvas/${encodeURIComponent(boundProjectId)}`);
      setFiles(data.files ?? []);
      // 体系绑定/项目改名后回读项目概要，工具栏不必等重开面板。
      setCanvas((current) =>
        current
          ? {
              ...current,
              name: data.project.name,
              designSystemId: data.project.designSystemId ?? null,
            }
          : current,
      );
      await loadSketches();
      if (canvas?.entryFile)
        await loadPreview(boundProjectId, canvas.entryFile);
    } catch (refreshError) {
      notify(
        refreshError instanceof Error ? refreshError.message : "刷新资源失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [boundProjectId, canvas?.entryFile, loadSketches, loadPreview]);

  /** 打开资源：切到该文件的预览；标签标题跟资源名走（默认是项目名）。 */
  const openFile = useCallback(
    async (file: string) => {
      if (!boundProjectId) return;
      setBusy(true);
      notify(null);
      setActiveVersion(null);
      setCurrentText(null);
      setVersions(null);
      const opened = await loadPreview(boundProjectId, file);
      if (opened) {
        setCanvas((current) =>
          current ? { ...current, entryFile: file } : current,
        );
        setResourceView(false);
        reportMeta({ title: resourceTitle(file) });
      }
      setBusy(false);
    },
    [boundProjectId, loadPreview, reportMeta],
  );

  /** 代码视图保存 Markdown：写回同一文件，正文与标签标题一起更新。 */
  const saveMarkdownSource = useCallback(
    async (source: string) => {
      if (!boundProjectId || !canvas?.entryFile) return;
      setMarkdownSaving(true);
      notify(null);
      try {
        await surfaceJson("/api/open-design/host/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: boundProjectId,
            name: canvas.entryFile,
            content: source,
            encoding: "utf8",
            versionLabel: "编辑文档",
          }),
        });
        setCurrentText(source);
        setMarkdownDraft(source);
        setMarkdownDirty(false);
        const title = markdownTitle(source);
        if (title) reportMeta({ title });
        notify("已保存");
      } catch (saveError) {
        notify(
          saveError instanceof Error ? saveError.message : "保存文档失败。",
        );
        throw saveError;
      } finally {
        setMarkdownSaving(false);
      }
    },
    [boundProjectId, canvas?.entryFile, reportMeta],
  );

  const saveMarkdown = useCallback(async () => {
    if (markdownDraft === null) return;
    try {
      await saveMarkdownSource(markdownDraft);
    } catch {
      // 错误提示由 saveMarkdownSource 走顶部 toast。
    }
  }, [markdownDraft, saveMarkdownSource]);

  const saveSource = useCallback(async () => {
    if (!boundProjectId || !canvas?.entryFile || sourceDraft === null) return;
    setSourceSaving(true);
    notify(null);
    try {
      await surfaceJson("/api/open-design/host/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: boundProjectId,
          name: canvas.entryFile,
          content: sourceDraft,
          encoding: "utf8",
          versionLabel: "编辑代码",
        }),
      });
      setCurrentText(sourceDraft);
      setSourceDirty(false);
      setFrameKey((key) => key + 1);
      notify("已保存");
    } catch (saveError) {
      notify(
        saveError instanceof Error ? saveError.message : "保存代码失败。",
      );
    } finally {
      setSourceSaving(false);
    }
  }, [boundProjectId, canvas?.entryFile, sourceDraft]);

  /** 重命名设计/文档：只改文件名，正文由宿主读写。 */
  const renameFile = useCallback(async () => {
    if (!boundProjectId || !renamingFile) return;
    const next = renamingFile.draft.trim();
    if (!next || next === renamingFile.name) {
      setRenamingFile(null);
      return;
    }
    setRenameBusy(true);
    notify(null);
    try {
      await surfaceJson("/api/open-design/host/file-rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: boundProjectId,
          name: renamingFile.name,
          newName: next,
        }),
      });
      const oldName = renamingFile.name;
      setFiles((current) =>
        current.map((file) =>
          file.name === oldName ? { ...file, name: next } : file,
        ),
      );
      setRenamingFile(null);
      if (canvas?.entryFile === oldName) {
        setCanvas((current) =>
          current ? { ...current, entryFile: next } : current,
        );
        await loadPreview(boundProjectId, next);
        // 文档标题仍取正文第一个一级标题；设计文件的标签跟文件名。
        if (!/\.md$/iu.test(next)) reportMeta({ title: resourceTitle(next) });
      }
      notify(`已重命名 ${next}`);
    } catch (renameError) {
      notify(
        renameError instanceof Error ? renameError.message : "重命名失败。",
      );
    } finally {
      setRenameBusy(false);
    }
  }, [
    boundProjectId,
    renamingFile,
    canvas?.entryFile,
    loadPreview,
    reportMeta,
  ]);

  /** 回到项目资源页：标签标题恢复项目名。 */
  const backToResources = useCallback(() => {
    setResourceView(true);
    setPreview(null);
    setDirectPreview(false);
    setCanvas((current) =>
      current ? { ...current, entryFile: null } : current,
    );
    setActiveVersion(null);
    setCurrentText(null);
    setVersions(null);
    setTool("none");
    setPicked(null);
    setPendingComment(null);
    setSidebarOpen(false);
    reportMeta({ title: canvas?.name || "未命名设计" });
  }, [canvas?.name, reportMeta]);

  /** 复制设计/文档：新名「-副本」由宿主去重生成。 */
  const copyFile = useCallback(
    async (name: string) => {
      if (!boundProjectId) return;
      setCopyingFile(name);
      try {
        const copied = await surfaceJson<{
          file: { name: string; kind: string };
        }>("/api/open-design/host/file-copy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: boundProjectId, name }),
        });
        setFiles((current) => [...current, copied.file]);
        notify(`已复制 ${copied.file.name}`);
      } catch (copyError) {
        notify(copyError instanceof Error ? copyError.message : "复制失败。");
      } finally {
        setCopyingFile(null);
      }
    },
    [boundProjectId],
  );

  /** 删除设计/文档：删掉当前打开的资源时退回资源页。 */
  const deleteFile = useCallback(async () => {
    if (!boundProjectId || !deletingFile) return;
    setDeleteBusy(true);
    try {
      await surfaceJson("/api/open-design/host/file-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: boundProjectId, name: deletingFile }),
      });
      const removed = deletingFile;
      setFiles((current) =>
        current.filter((file) => file.name !== removed),
      );
      setDeletingFile(null);
      if (canvas?.entryFile === removed) backToResources();
      notify(`已删除 ${removed}`);
    } catch (deleteError) {
      notify(deleteError instanceof Error ? deleteError.message : "删除失败。");
    } finally {
      setDeleteBusy(false);
    }
  }, [boundProjectId, deletingFile, canvas?.entryFile, backToResources]);

  /** 新建草图 = 当前项目的 Design 画布（不是上游 sketch 文件）。 */
  const createSketch = useCallback(async () => {
    if (!workspaceProjectId) return;
    setBusy(true);
    notify(null);
    try {
      const created = await surfaceJson<{
        canvas: { id: string; name: string };
      }>(`/api/projects/${encodeURIComponent(workspaceProjectId)}/canvases`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "未命名草图",
          requestId: crypto.randomUUID(),
        }),
      });
      await loadSketches();
      requestCanvasDocumentOpen({
        projectId: workspaceProjectId,
        documentId: created.canvas.id,
        title: created.canvas.name,
      });
    } catch (createError) {
      notify(
        createError instanceof Error ? createError.message : "新建草图失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [workspaceProjectId, loadSketches]);

  /** 新建文档：在当前设计项目的资源里写一份 Markdown，并打开它。 */
  const createDocument = useCallback(async () => {
    if (!boundProjectId) return;
    setBusy(true);
    notify(null);
    try {
      const created = await surfaceJson<{
        file: { name: string; kind: string };
      }>("/api/open-design/host/design-document", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: boundProjectId,
          name: "未命名文档",
        }),
      });
      setFiles((current) => [...current, created.file]);
      await openFile(created.file.name);
      setViewMode("code");
    } catch (createError) {
      notify(
        createError instanceof Error ? createError.message : "新建文档失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [boundProjectId, openFile]);

  /** 新建设计稿：在当前设计项目的资源里写一份 HTML，并打开代码视图。 */
  const createDesignFile = useCallback(async () => {
    if (!boundProjectId) return;
    setBusy(true);
    notify(null);
    try {
      const created = await surfaceJson<{
        file: { name: string; kind: string };
      }>("/api/open-design/host/design-file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: boundProjectId,
          name: "未命名设计",
        }),
      });
      setFiles((current) => [...current, created.file]);
      await openFile(created.file.name);
      setViewMode("code");
    } catch (createError) {
      notify(
        createError instanceof Error ? createError.message : "新建设计稿失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [boundProjectId, openFile]);

  /** 保存到工作目录（引擎 → 我们）：画布文件写进当前 Task 工作目录。 */
  const [saveToWorkspaceBusy, setSaveToWorkspaceBusy] = useState(false);
  const saveToWorkspace = useCallback(async () => {
    if (!boundProjectId || !workspacePath) return;
    setSaveToWorkspaceBusy(true);
    notify(null);
    try {
      const saved = await surfaceJson<{ path: string; bytes: number }>(
        "/api/open-design/host/save-to-workspace",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: boundProjectId,
            workspacePath,
            ...(canvas?.entryFile ? { file: canvas.entryFile } : {}),
          }),
        },
      );
      notify(`已保存：${saved.path}`);
    } catch (saveError) {
      notify(
        saveError instanceof Error ? saveError.message : "保存到工作目录失败。",
      );
    } finally {
      setSaveToWorkspaceBusy(false);
    }
  }, [boundProjectId, canvas?.entryFile, workspacePath]);

  /**
   * 同步到引擎（自动，无手动按钮）：把本仓评论与标注聚进 daemon 项目的
   * document.md 受管段。成功静默（高频后台动作不打扰），失败 toast 人话。
   */
  const syncContextToEngine = useCallback(async () => {
    if (!boundProjectId) return;
    try {
      await surfaceJson("/api/open-design/host/context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: boundProjectId }),
      });
    } catch (syncError) {
      notify(
        syncError instanceof Error ? syncError.message : "同步到引擎失败。",
      );
    }
  }, [boundProjectId]);

  /**
   * **自动同步**（用户口径 2026-10-24「需要自动同步，而不是手动同步」）：
   * 评论/标注一变就去抖同步进 document.md——手动按钮已移除，引擎侧上下文
   * 始终跟面板一致。签名只含内容相关字段：选中态/活跃 id 这类 UI 状态变化
   * 不触发。失败只 toast 不打断编辑；每次打开面板也会对齐一次（幂等写）。
   */
  const reviewSignature = JSON.stringify([
    review.annotations.map((a) => [
      a.id,
      a.kind,
      JSON.stringify(a.points),
      a.color,
    ]),
    review.comments.map((c) => [c.id, c.body, c.status]),
  ]);
  const autoSyncRef = useRef(syncContextToEngine);
  autoSyncRef.current = syncContextToEngine;
  const autoSyncDoneRef = useRef("");
  useEffect(() => {
    if (!boundProjectId) return;
    if (autoSyncDoneRef.current === reviewSignature) return;
    const timer = window.setTimeout(() => {
      autoSyncDoneRef.current = reviewSignature;
      void autoSyncRef.current();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [reviewSignature, boundProjectId]);

  /**
   * 设计体系选择：选中的体系经宿主代理 PATCH 到 daemon 项目的 designSystemId；
   * 新建走来源提取，完成后再复用同一条绑定径。
   */
  const emptyUploadInputRef = useRef<HTMLInputElement>(null);
  const [designSystems, setDesignSystems] = useState<
    | { state: "loading" }
    | {
        state: "ready";
        items: Array<{
          id: string;
          title: string;
          category: string | null;
          swatches: string[];
        }>;
      }
    | { state: "error"; message: string }
    | null
  >(null);
  const [designSystemCreateOpen, setDesignSystemCreateOpen] = useState(false);
  const [designSourceUrl, setDesignSourceUrl] = useState("");
  const [designSourceUrls, setDesignSourceUrls] = useState<string[]>([]);
  const [designDescription, setDesignDescription] = useState("");
  const [designMarkdown, setDesignMarkdown] = useState("");
  const [designSystemCreating, setDesignSystemCreating] = useState(false);
  /** 刚绑定/新建的体系标题：清单关闭后工具栏仍显示名字，不退化成 id。 */
  const [designSystemTitleHint, setDesignSystemTitleHint] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [designCreateStatus, setDesignCreateStatus] = useState<string | null>(
    null,
  );
  const [designCreateError, setDesignCreateError] = useState<string | null>(
    null,
  );
  const openDesignSystemCreate = useCallback(() => {
    setDesignSystems(null);
    setDesignSystemCreateOpen(true);
    setDesignCreateError(null);
    setDesignCreateStatus(null);
  }, []);
  const closeDesignSystemCreate = useCallback(() => {
    if (designSystemCreating) return;
    setDesignSystemCreateOpen(false);
    setDesignCreateError(null);
    setDesignCreateStatus(null);
  }, [designSystemCreating]);
  const openDesignSystemPicker = useCallback(async () => {
    setDesignSystems({ state: "loading" });
    try {
      const listed = await surfaceJson<{
        designSystems: Array<{
          id: string;
          title: string;
          category: string | null;
          swatches: string[];
        }>;
      }>("/api/open-design/host/design-systems");
      setDesignSystems({ state: "ready", items: listed.designSystems });
    } catch (listError) {
      setDesignSystems({
        state: "error",
        message:
          listError instanceof Error ? listError.message : "读取设计体系失败。",
      });
    }
  }, []);
  const bindDesignSystem = useCallback(
    async (designSystemId: string, title: string) => {
      setBusy(true);
      try {
        if (!boundProjectId) return;
        await surfaceJson("/api/open-design/host/design-systems/bind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: boundProjectId, designSystemId }),
        });
        setDesignSystemTitleHint({ id: designSystemId, title });
        setDesignSystems(null);
        await refresh();
        notify(`已应用设计体系 ${title}`);
      } catch (bindError) {
        notify(
          bindError instanceof Error ? bindError.message : "绑定失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [boundProjectId, refresh],
  );

  const addDesignSourceUrl = useCallback(() => {
    const url = designSourceUrl.trim();
    if (!url) return;
    if (designSourceUrls.includes(url)) {
      setDesignSourceUrl("");
      return;
    }
    if (designSourceUrls.length >= 5) {
      setDesignCreateError("最多添加 5 个来源。");
      return;
    }
    setDesignSourceUrls((current) => [...current, url]);
    setDesignSourceUrl("");
    setDesignCreateError(null);
  }, [designSourceUrl, designSourceUrls]);

  /**
   * 新建设计体系：与上游 `/design-systems/create` 同一条提取链路。
   * 网站或 DESIGN.md 交给上游品牌提取，完成后把体系绑到当前项目。
   */
  const createDesignSystem = useCallback(async () => {
    if (!boundProjectId || designSystemCreating) return;
    const urls = [
      ...designSourceUrls,
      ...(designSourceUrl.trim() ? [designSourceUrl.trim()] : []),
    ].filter((url, index, list) => list.indexOf(url) === index);
    const designMd = designMarkdown.trim() ? designMarkdown : undefined;
    if (urls.length === 0 && !designMd) {
      setDesignCreateError("至少提供网站或 DESIGN.md。");
      return;
    }
    const extraSources = urls
      .slice(1)
      .map((url) => `- ${url}`)
      .join("\n");
    const description = [
      designDescription.trim(),
      extraSources ? `其他参考链接：\n${extraSources}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    setBusy(true);
    notify(null);
    setDesignSystemCreating(true);
    setDesignCreateError(null);
    setDesignCreateStatus("正在读取来源…");
    try {
      const started = await surfaceJson<{
        extraction: {
          id: string;
          status: string;
          designSystemId: string | null;
          title: string | null;
          error: string | null;
        };
      }>("/api/open-design/host/design-systems", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(urls[0] ? { url: urls[0] } : {}),
          ...(description ? { description } : {}),
          ...(designMd ? { designMd } : {}),
        }),
      });
      let extraction = started.extraction;
      for (
        let attempt = 0;
        extraction.status === "extracting" ||
        extraction.status === "queued" ||
        extraction.status === "starting";
        attempt += 1
      ) {
        if (attempt >= 120) {
          throw new Error(
            urls[0]
              ? "网站读取超时，改用 DESIGN.md 再试。"
              : "DESIGN.md 提取超时，再试一次。",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 800));
        const polled = await surfaceJson<{
          extraction: typeof extraction;
        }>(
          `/api/open-design/host/design-systems/extractions/${encodeURIComponent(extraction.id)}`,
        );
        extraction = polled.extraction;
        setDesignCreateStatus(
          extraction.status === "ready" ? "已生成" : "正在提取…",
        );
      }
      if (extraction.status !== "ready" || !extraction.designSystemId) {
        const raw = extraction.error?.trim() ?? "";
        const fallback = urls[0]
          ? "网站没取到可用素材，改用 DESIGN.md 再试。"
          : "DESIGN.md 没提取出来，再试一次。";
        throw new Error(raw && /[\u4e00-\u9fff]/u.test(raw) ? raw : fallback);
      }
      await surfaceJson("/api/open-design/host/design-systems/bind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: boundProjectId,
          designSystemId: extraction.designSystemId,
        }),
      });
      setDesignSystemTitleHint({
        id: extraction.designSystemId,
        title: extraction.title ?? "设计体系",
      });
      setDesignSystemCreateOpen(false);
      setDesignCreateStatus(null);
      setDesignSourceUrl("");
      setDesignSourceUrls([]);
      setDesignDescription("");
      setDesignMarkdown("");
      await refresh();
      notify(`已新建设计体系 ${extraction.title ?? "设计体系"}`);
    } catch (createError) {
      setDesignCreateError(
        createError instanceof Error
          ? createError.message
          : "新建设计体系失败。",
      );
    } finally {
      setBusy(false);
      setDesignSystemCreating(false);
      setDesignCreateStatus(null);
    }
  }, [
    boundProjectId,
    designDescription,
    designMarkdown,
    designSourceUrl,
    designSourceUrls,
    designSystemCreating,
    refresh,
  ]);

  const uploadAsset = useCallback(
    async (file: File) => {
      if (file.size > UPLOAD_MAX_BYTES) {
        notify("文件超过 1.5 MB，请换小一点的资源。");
        return;
      }
      setBusy(true);
      notify(null);
      try {
        if (!boundProjectId) return;
        const content = await fileToBase64(file);
        await surfaceJson("/api/open-design/host/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: boundProjectId,
            name: file.name.replace(UNSAFE_FILENAME_CHARS, "-"),
            content,
            encoding: "base64",
          }),
        });
        // 先刷新再报成功：refresh 会清 notice，反过来写会让提示刚出现就被抹掉。
        await refresh();
        notify(`已上传 ${file.name}`);
      } catch (uploadError) {
        notify(
          uploadError instanceof Error ? uploadError.message : "上传失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [boundProjectId, refresh],
  );

  /** 保存可视化编辑：改动落到源文本，再由源文本重挂文档。 */
  const saveEdit = useCallback(
    async (draft: OpenDesignEditDraft) => {
      if (!picked || !canvas?.entryFile || currentText === null) return;
      const style: {
        backgroundColor?: string;
        color?: string;
        fontSize?: string;
        fontWeight?: string;
        textAlign?: string;
        padding?: string;
        margin?: string;
        borderRadius?: string;
      } = {};
      if (draft.color) style.color = draft.color;
      if (draft.backgroundColor) style.backgroundColor = draft.backgroundColor;
      if (draft.fontSize) style.fontSize = draft.fontSize;
      if (draft.fontWeight) style.fontWeight = draft.fontWeight;
      if (draft.textAlign) style.textAlign = draft.textAlign;
      if (draft.padding) style.padding = draft.padding;
      if (draft.margin) style.margin = draft.margin;
      if (draft.borderRadius) style.borderRadius = draft.borderRadius;
      const next = applyElementEdit(currentText, {
        path: picked.path,
        ...(draft.html === picked.html ? {} : { html: draft.html }),
        ...(Object.keys(style).length > 0 ? { style } : {}),
      });
      if (next === null) {
        notify("这个元素已经不在当前正文里，改动没有保存。");
        return;
      }
      setBusy(true);
      notify(null);
      try {
        await surfaceJson("/api/open-design/host/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: canvas.projectId,
            name: canvas.entryFile,
            content: next,
            versionLabel: "手动编辑",
          }),
        });
        // 正文是真相：改完只换正文并重挂文档，历史版本由上游记一条 manual。
        setCurrentText(next);
        setPicked(null);
        setFrameKey((key) => key + 1);
        notify("已保存");
      } catch (saveError) {
        notify(
          saveError instanceof Error ? saveError.message : "保存失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [canvas, currentText, picked],
  );

  /** 截图/导出/交接的输入：历史版本优先，否则当前文件正文。 */
  const resolveActiveHtml = useCallback(async (): Promise<string | null> => {
    if (activeVersion?.text) return activeVersion.text;
    if (currentText !== null) return currentText;
    if (!canvas?.entryFile) {
      notify("画布还没有内容");
      return null;
    }
    return loadCurrentText();
  }, [activeVersion, canvas?.entryFile, currentText, loadCurrentText]);

  const capturePng = useCallback(async (): Promise<string | null> => {
    const html = await resolveActiveHtml();
    if (!html) return null;
    const box = frameWrapRef.current;
    const width = Math.max(
      CAPTURE_MIN_SIDE,
      Math.round(box?.clientWidth ?? CAPTURE_FALLBACK_SIZE.width),
    );
    const height = Math.max(
      CAPTURE_MIN_SIDE,
      Math.round(box?.clientHeight ?? CAPTURE_FALLBACK_SIZE.height),
    );
    return rasterizeDesignHtml(html, width, height);
  }, [resolveActiveHtml]);

  const screenshotToChat = useCallback(async () => {
    setBusy(true);
    notify(null);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const file = await dataUrlToFile(dataUrl, canvas?.name ?? "画布");
      const delivered = dispatchOpenDesignCanvasAddToChat({
        projectId: canvas?.projectId ?? boundProjectId ?? "",
        title: canvas?.name ?? null,
        file,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!delivered) notify("先点一下对话输入框");
    } catch (captureError) {
      notify(
        captureError instanceof Error ? captureError.message : "截图失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [boundProjectId, canvas, capturePng, workspaceIdentity, workspacePath]);

  /** 交给对话（上游 Handoff 的本地化）：把设计文件本身作为附件送进 composer。 */
  const handoffToChat = useCallback(async () => {
    setBusy(true);
    notify(null);
    try {
      const html = await resolveActiveHtml();
      if (!html || !canvas?.entryFile) return;
      const file = new File([html], canvas.entryFile, { type: "text/html" });
      const delivered = dispatchOpenDesignCanvasAddToChat({
        projectId: canvas.projectId,
        title: canvas.name,
        file,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (!delivered) notify("先点一下对话输入框");
    } catch (handoffError) {
      notify(
        handoffError instanceof Error ? handoffError.message : "交接失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [canvas, resolveActiveHtml, workspaceIdentity, workspacePath]);

  const exportPng = useCallback(async () => {
    setBusy(true);
    notify(null);
    try {
      const dataUrl = await capturePng();
      if (!dataUrl) return;
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${(canvas?.name ?? "画布").replace(UNSAFE_FILENAME_CHARS, "-")}.png`;
      anchor.click();
    } catch (captureError) {
      notify(
        captureError instanceof Error ? captureError.message : "导出失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [canvas, capturePng]);

  const exportHtml = useCallback(async () => {
    setBusy(true);
    notify(null);
    try {
      const html = await resolveActiveHtml();
      if (!html || !canvas?.entryFile) return;
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = canvas.entryFile.replace(UNSAFE_FILENAME_CHARS, "-");
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      notify(
        exportError instanceof Error ? exportError.message : "导出失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [canvas, resolveActiveHtml]);

  const exportZip = useCallback(async () => {
    if (!boundProjectId) return;
    setBusy(true);
    notify(null);
    try {
      const response = await surfaceRequest(
        `/api/open-design/host/archive?projectId=${encodeURIComponent(boundProjectId)}`,
      );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(canvas?.name ?? "设计项目").replace(UNSAFE_FILENAME_CHARS, "-")}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (zipError) {
      notify(
        zipError instanceof Error ? zipError.message : "导出 ZIP 失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [boundProjectId, canvas?.name]);

  const buildPrintableHtml = useCallback(async () => {
    const html = await resolveActiveHtml();
    if (!html) return null;
    const base = assetBaseUrl ? `<base href="${assetBaseUrl}">` : "";
    if (/<head[^>]*>/iu.test(html)) {
      return html.replace(/<head([^>]*)>/iu, `<head$1>${base}`);
    }
    return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
  }, [assetBaseUrl, resolveActiveHtml]);

  const exportPdf = useCallback(async () => {
    setBusy(true);
    notify(null);
    try {
      const html = await buildPrintableHtml();
      if (!html) return;
      // 打印用沙箱 iframe：不给 allow-scripts，设计里的脚本不会在本仓 origin 执行。
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.style.cssText =
        "position:fixed;left:0;top:0;width:1024px;height:768px;opacity:0;pointer-events:none;z-index:-1";
      frame.srcdoc = html;
      await new Promise<void>((resolve) => {
        frame.onload = () => resolve();
        document.body.appendChild(frame);
        setTimeout(resolve, 1500);
      });
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 1500);
    } catch (pdfError) {
      notify(
        pdfError instanceof Error ? pdfError.message : "导出 PDF 失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [buildPrintableHtml]);

  /**
   * 分享 = 静态部署（用户口径：像原来的分享一样，不复制面板 localhost 链接）：
   * 代理上游部署面把入口 HTML 发布到 Cloudflare Pages / Vercel（用户自带 token）。
   * 菜单里另给「配置托管商」与「打开已发布页面」。
   */
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  const [shareConfigProvider, setShareConfigProvider] = useState<
    "cloudflare-pages" | "vercel-self" | null
  >(null);
  const [shareConfig, setShareConfig] = useState<{
    token: string;
    accountId: string;
    teamSlug: string;
  }>({ token: "", accountId: "", teamSlug: "" });
  const [lastDeploymentUrl, setLastDeploymentUrl] = useState<string | null>(
    null,
  );
  const [shareBusy, setShareBusy] = useState(false);

  const copyDeployedLink = useCallback(async () => {
    if (!lastDeploymentUrl) return;
    try {
      await navigator.clipboard.writeText(lastDeploymentUrl);
      notify("已复制发布链接");
    } catch {
      notify("复制失败，请检查剪贴板权限。");
    }
  }, [lastDeploymentUrl]);

  const deployTo = useCallback(
    async (providerId: "cloudflare-pages" | "vercel-self") => {
      if (!boundProjectId) return;
      setShareBusy(true);
      setShareMenuOpen(false);
      notify(null);
      try {
        const deployed = await surfaceJson<{
          url: string;
          providerId: string;
        }>("/api/open-design/host/deploy", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: boundProjectId,
            providerId,
            ...(canvas?.entryFile ? { file: canvas.entryFile } : {}),
          }),
        });
        setLastDeploymentUrl(deployed.url);
        try {
          await navigator.clipboard.writeText(deployed.url);
          notify(`已发布并复制链接：${deployed.url}`);
        } catch {
          notify(`已发布：${deployed.url}`);
        }
      } catch (deployError) {
        notify(
          deployError instanceof Error ? deployError.message : "发布失败。",
        );
      } finally {
        setShareBusy(false);
      }
    },
    [boundProjectId, canvas?.entryFile],
  );

  const openShareConfig = useCallback(
    async (providerId: "cloudflare-pages" | "vercel-self") => {
      setShareMenuOpen(false);
      setShareConfigProvider(providerId);
      setShareConfig({ token: "", accountId: "", teamSlug: "" });
      try {
        const current = await surfaceJson<{
          tokenMask: string;
          accountId?: string;
          teamSlug?: string;
        }>(
          `/api/open-design/host/deploy/config?providerId=${encodeURIComponent(providerId)}`,
        );
        setShareConfig({
          token: current.tokenMask,
          accountId: current.accountId ?? "",
          teamSlug: current.teamSlug ?? "",
        });
      } catch {
        // 读不到配置就留空表单，保存时按服务端报错指路
      }
    },
    [],
  );

  const saveShareConfig = useCallback(async () => {
    if (!shareConfigProvider) return;
    setShareBusy(true);
    try {
      await surfaceJson("/api/open-design/host/deploy/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: shareConfigProvider,
          token: shareConfig.token,
          ...(shareConfig.accountId
            ? { accountId: shareConfig.accountId }
            : {}),
          ...(shareConfig.teamSlug ? { teamSlug: shareConfig.teamSlug } : {}),
        }),
      });
      setShareConfigProvider(null);
      notify("托管商配置已保存");
    } catch (saveError) {
      notify(
        saveError instanceof Error ? saveError.message : "保存配置失败。",
      );
    } finally {
      setShareBusy(false);
    }
  }, [shareConfig, shareConfigProvider]);

  const loadVersions = useCallback(async () => {
    if (
      !canvas?.entryFile ||
      !/\.html?$/iu.test(canvas.entryFile) ||
      versionsLoading
    )
      return;
    setVersionsLoading(true);
    try {
      const data = await surfaceJson<{ versions: OpenDesignVersionSummary[] }>(
        `/api/open-design/host/versions?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}`,
      );
      setVersions(data.versions);
    } catch (loadError) {
      notify(
        loadError instanceof Error ? loadError.message : "读取历史版本失败。",
      );
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }, [canvas, versionsLoading]);

  const selectVersion = useCallback(
    async (versionId: string | null) => {
      if (!versionId) {
        setActiveVersion(null);
        return;
      }
      if (!canvas?.entryFile) return;
      setBusy(true);
      notify(null);
      try {
        const data = await surfaceJson<{
          version: { id: string; label: string; version: number };
          text: string;
        }>(
          `/api/open-design/host/version-content?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}&versionId=${encodeURIComponent(versionId)}`,
        );
        setActiveVersion({
          id: data.version.id,
          label: `V${data.version.version}`,
          text: data.text,
        });
        setFrameLoaded(false);
        setPhase("ready");
      } catch (loadError) {
        notify(
          loadError instanceof Error ? loadError.message : "读取历史版本失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [canvas],
  );

  const restoreActiveVersion = useCallback(async () => {
    if (!activeVersion || !canvas?.entryFile) return;
    setRestoringVersion(true);
    notify(null);
    try {
      await surfaceJson("/api/open-design/host/version-restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: canvas.projectId,
          file: canvas.entryFile,
          versionId: activeVersion.id,
        }),
      });
      setActiveVersion(null);
      setVersions(null);
      await loadCurrentText();
      setFrameLoaded(false);
      setFrameKey((key) => key + 1);
      await loadVersions();
      notify(`已恢复 ${activeVersion.label}`);
    } catch (restoreError) {
      notify(
        restoreError instanceof Error ? restoreError.message : "恢复版本失败。",
      );
    } finally {
      setRestoringVersion(false);
    }
  }, [activeVersion, canvas, loadCurrentText, loadVersions]);

  const downloadActiveVersion = useCallback(() => {
    if (!activeVersion || !canvas) return;
    const extension = /\.md$/iu.test(canvas.entryFile ?? "") ? "md" : "html";
    const blob = new Blob([activeVersion.text], {
      type: extension === "md" ? "text/markdown" : "text/html",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${canvas.name.replace(UNSAFE_FILENAME_CHARS, "-")}-${activeVersion.label}.${extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [activeVersion, canvas]);

  // 版本列表随画布就绪即取（本机 daemon，一次小请求）：菜单打开不再夹带请求，
  // 避免展开瞬间的 state 更新干扰菜单自身的焦点/开合。
  useEffect(() => {
    if (phase !== "ready" || !canvas?.entryFile) return;
    // 上游只给 HTML 记版本；草图/文档不必发这条请求，更不该把 400 当提示挂出来。
    // 只在首次置空，避免每次 effect 都换新数组把渲染打进循环。
    if (!/\.html?$/iu.test(canvas.entryFile)) {
      if (versions === null) setVersions([]);
      return;
    }
    if (versions !== null) return;
    void loadVersions();
  }, [canvas?.entryFile, loadVersions, phase, versions]);

  const frameSize =
    viewport === "tablet"
      ? { width: 820, height: 1180 }
      : viewport === "mobile"
        ? { width: 390, height: 844 }
        : null;
  const scale = zoom / 100;
  const isMarkdownEntry = Boolean(
    canvas?.entryFile && /\.md$/iu.test(canvas.entryFile),
  );
  const isHtmlEntry = Boolean(
    canvas?.entryFile && /\.html?$/iu.test(canvas.entryFile),
  );
  useEffect(() => {
    if (!isHtmlEntry || currentText === null) {
      setSourceDraft(null);
      setSourceDirty(false);
      return;
    }
    if (sourceFileRef.current !== canvas?.entryFile) {
      sourceFileRef.current = canvas?.entryFile ?? null;
      setSourceDraft(currentText);
      setSourceDirty(false);
      return;
    }
    // 编辑中的草稿不被异步回读覆盖；保存成功后 dirty 已复位。
    if (!sourceDirty) setSourceDraft(currentText);
  }, [canvas?.entryFile, currentText, isHtmlEntry, sourceDirty]);
  useEffect(() => {
    if (!isMarkdownEntry || currentText === null) {
      setMarkdownDraft(null);
      setMarkdownDirty(false);
      return;
    }
    // 编辑中的草稿不被异步回读覆盖；保存成功后 dirty 已复位。
    if (!markdownDirty) setMarkdownDraft(currentText);
  }, [currentText, isMarkdownEntry, markdownDirty]);
  const captureReady =
    phase === "ready" &&
    Boolean(canvas?.entryFile) &&
    !directPreview &&
    !isMarkdownEntry;
  const htmlFiles = files.filter((file) => /\.html?$/iu.test(file.name));
  const markdownFiles = files.filter((file) => /\.md$/iu.test(file.name));
  const otherFiles = files.filter(
    (file) => !/\.html?$/iu.test(file.name) && !/\.md$/iu.test(file.name),
  );
  const isRenameableFile = (name: string) => /\.(?:html?|md)$/iu.test(name);
  const renderFileCard = (file: { name: string; kind: string }) => {
    return (
      <div
        key={file.name}
        className="group/row flex min-w-0 items-center rounded-lg border border-border bg-surface hover:bg-surface-hover"
      >
        <button
          type="button"
          data-open-design-resource="file"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-ui-base"
          onClick={() => void openFile(file.name)}
        >
          <FileText className="size-4 shrink-0 text-foreground-subtle" />
          <span className="min-w-0 truncate">{resourceTitle(file.name)}</span>
        </button>
        {isRenameableFile(file.name) ? (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`更多操作 ${resourceTitle(file.name)}`}
                title="更多"
                className="mr-1 shrink-0 text-foreground-subtle hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem
                data-open-design-file-action="rename"
                onSelect={() =>
                  setRenamingFile({ name: file.name, draft: file.name })
                }
              >
                <Pencil className="size-3.5" />
                <span className="flex-1">重命名</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                data-open-design-file-action="copy"
                disabled={copyingFile === file.name}
                onSelect={() => void copyFile(file.name)}
              >
                <Copy className="size-3.5" />
                <span className="flex-1">复制</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                data-open-design-file-action="delete"
                onSelect={() => setDeletingFile(file.name)}
              >
                <Trash2 className="size-3.5" />
                <span className="flex-1">删除</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    );
  };
  const renderFileSection = (
    label: string,
    items: Array<{ name: string; kind: string }>,
  ) =>
    items.length > 0 ? (
      <section className="flex flex-col gap-1.5">
        <span className="text-ui-caption text-foreground-subtle">{label}</span>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
          {items.map(renderFileCard)}
        </div>
      </section>
    ) : null;
  const showCanvas = phase === "ready" && Boolean(canvas?.entryFile);

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

  const hasDesignSource =
    designSourceUrl.trim().length > 0 ||
    designSourceUrls.length > 0 ||
    designMarkdown.trim().length > 0;

  return (
    <div
      data-testid="open-design-pane"
      className="flex h-full w-full flex-col bg-background"
    >
      {!resourceView ? (
        <OpenDesignToolbar
          busy={busy}
          hasCanvas={captureReady}
          viewMode={viewMode}
          onViewMode={setViewMode}
          viewport={viewport}
          onViewport={setViewport}
          zoom={zoom}
          onZoom={setZoom}
          tool={tool}
          onTool={(next) => {
            setTool(next);
            if (next !== "edit") setPicked(null);
            if (next !== "comment") setPendingComment(null);
          }}
          annotationKind={annotationKind}
          onAnnotationKind={setAnnotationKind}
          commentCount={
            review.comments.filter((item) => item.status === "open").length
          }
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          showBack={Boolean(canvas?.entryFile)}
          onBackToResources={backToResources}
          onCreateSketch={() => void createSketch()}
          onCreateDocument={() => void createDocument()}
          onCreateDesignFile={() => void createDesignFile()}
          markdownMode={isMarkdownEntry}
          fileName={
            canvas?.entryFile ? resourceTitle(canvas.entryFile) : null
          }
          onRename={() => {
            if (canvas?.entryFile)
              setRenamingFile({
                name: canvas.entryFile,
                draft: canvas.entryFile,
              });
          }}
          markdownDirty={markdownDirty}
          markdownSaving={markdownSaving}
          onSaveMarkdown={() => void saveMarkdown()}
          onUploadAsset={(file) => void uploadAsset(file)}
          onOpenBrowserTab={onOpenBrowserTab}
          onSaveToWorkspace={() => void saveToWorkspace()}
          saveToWorkspaceBusy={saveToWorkspaceBusy}
          activeDesignSystemTitle={
            canvas?.designSystemId
              ? ((designSystems?.state === "ready"
                  ? designSystems.items.find(
                      (item) => item.id === canvas.designSystemId,
                    )?.title
                  : null) ??
                (designSystemTitleHint?.id === canvas.designSystemId
                  ? designSystemTitleHint.title
                  : null) ??
                canvas.designSystemId)
              : null
          }
          onOpenDesignSystems={() => void openDesignSystemPicker()}
          onCreateDesignSystem={openDesignSystemCreate}
          versions={versions}
          versionsLoading={versionsLoading}
          activeVersionId={activeVersion?.id ?? null}
          onSelectVersion={(id) => void selectVersion(id)}
          onRefresh={() => void refresh()}
          onScreenshot={() => void screenshotToChat()}
          onHandoff={() => void handoffToChat()}
          onExportPng={() => void exportPng()}
          onExportHtml={() => void exportHtml()}
          onExportPdf={() => void exportPdf()}
          onExportZip={() => void exportZip()}
          onShare={() => setShareMenuOpen((open) => !open)}
          shareBusy={shareBusy}
          shareMenuOpen={shareMenuOpen}
          lastDeploymentUrl={lastDeploymentUrl}
          onDeploy={(providerId) => void deployTo(providerId)}
          onShareConfig={openShareConfig}
          onOpenDeployment={() => {
            if (lastDeploymentUrl)
              window.open(lastDeploymentUrl, "_blank", "noopener");
          }}
          onCopyDeployedLink={() => void copyDeployedLink()}
        />
      ) : null}
      {readiness?.reachable && !readiness.agentAvailable ? (
        <div
          role="status"
          data-testid="open-design-readiness"
          className="shrink-0 border-b border-border px-3 py-2 text-ui-caption text-foreground-subtle"
        >
          没有可用的设计引擎
        </div>
      ) : null}
      {activeVersion ? (
        <div
          role="status"
          data-testid="open-design-version-banner"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-ui-caption text-foreground-subtle"
        >
          <span>正在查看历史版本 {activeVersion.label}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={downloadActiveVersion}
          >
            下载
          </Button>
          <Button
            type="button"
            size="xs"
            disabled={restoringVersion}
            onClick={() => void restoreActiveVersion()}
          >
            {restoringVersion ? "恢复中…" : "恢复此版本"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void selectVersion(null)}
          >
            回到当前
          </Button>
        </div>
      ) : null}
      <div ref={frameWrapRef} className="relative min-h-0 flex-1 overflow-auto">
        {showCanvas && viewMode === "code" && isMarkdownEntry ? (
          <div
            data-testid="open-design-markdown-editor"
            className="flex h-full flex-col"
          >
            <textarea
              aria-label="Markdown 源码"
              value={markdownDraft ?? ""}
              spellCheck={false}
              onChange={(event) => {
                setMarkdownDraft(event.target.value);
                setMarkdownDirty(true);
              }}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  void saveMarkdown();
                }
              }}
              className="min-h-0 w-full flex-1 resize-none bg-background p-3 font-mono text-xs text-foreground outline-none"
            />
          </div>
        ) : showCanvas && viewMode === "code" && !directPreview ? (
          activeVersion ? (
            <pre
              data-testid="open-design-source"
              className="m-0 h-full overflow-auto whitespace-pre-wrap break-words bg-background p-3 font-mono text-xs text-foreground"
            >
              {activeVersion.text}
            </pre>
          ) : (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
                <span className="text-ui-caption text-foreground-subtle">
                  代码
                </span>
                <Button
                  type="button"
                  size="xs"
                  disabled={!sourceDirty || sourceSaving}
                  onClick={() => void saveSource()}
                >
                  {sourceSaving ? "保存中…" : "保存"}
                </Button>
              </div>
              <textarea
                aria-label="代码源"
                data-testid="open-design-source"
                value={sourceDraft ?? ""}
                spellCheck={false}
                onChange={(event) => {
                  setSourceDraft(event.target.value);
                  setSourceDirty(true);
                }}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key.toLowerCase() === "s"
                  ) {
                    event.preventDefault();
                    void saveSource();
                  }
                }}
                className="min-h-0 flex-1 resize-none bg-background p-3 font-mono text-xs text-foreground outline-none"
              />
            </div>
          )
        ) : null}
        {showCanvas && viewMode === "preview" && isMarkdownEntry ? (
          currentText === null ? (
            <div className="flex h-full items-center justify-center">
              <ZCodeStartupSpinner />
            </div>
          ) : (
            <OpenDesignMarkdownPreview
              source={currentText}
              saving={markdownSaving}
              onSave={saveMarkdownSource}
            />
          )
        ) : null}
        {showCanvas &&
        viewMode === "preview" &&
        directPreview &&
        directPreviewSrc ? (
          <iframe
            key={documentKey}
            src={directPreviewSrc}
            sandbox={preview?.iframeSandbox ?? "allow-scripts"}
            title="OpenDesign"
            className="h-full w-full border-0 bg-white"
          />
        ) : null}
        {showCanvas &&
        viewMode === "preview" &&
        !directPreview &&
        !isMarkdownEntry ? (
          <div
            className={
              frameSize
                ? "flex min-h-full w-full items-start justify-center bg-surface p-4"
                : "h-full w-full"
            }
          >
            <div
              data-testid="open-design-frame-shell"
              className="relative shrink-0 overflow-hidden bg-white"
              style={{
                ...(frameSize
                  ? { width: frameSize.width, height: frameSize.height }
                  : { width: "100%", height: "100%" }),
                ...(frameSize ? { maxWidth: "100%" } : {}),
                ...(scale !== 1 ? { zoom: scale } : {}),
              }}
            >
              <iframe
                key={documentKey}
                ref={frameRef}
                srcDoc={documentHtml ?? ""}
                sandbox="allow-scripts allow-forms"
                title="OpenDesign"
                data-od-version={activeVersion?.id ?? undefined}
                style={{ width: "100%", height: "100%" }}
                className={`border-0 bg-white transition-opacity duration-300 ${
                  frameLoaded ? "opacity-100" : "opacity-0"
                }`}
                onLoad={() => setFrameLoaded(true)}
              />
            </div>
            {!frameLoaded ? (
              <div
                role="status"
                className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-background"
              >
                <ZCodeStartupLogoBadge />
                <ZCodeStartupSpinner />
              </div>
            ) : null}
          </div>
        ) : null}
        {showCanvas &&
        viewMode === "preview" &&
        !directPreview &&
        !isMarkdownEntry &&
        overlayBox &&
        docSize ? (
          <OpenDesignMarkup
            comments={review.comments}
            annotations={review.annotations}
            rects={rects}
            box={overlayBox}
            metrics={docSize}
            drawing={tool === "annotate"}
            erasing={tool === "erase"}
            adjusting={tool === "adjust"}
            elementSelecting={tool === "element"}
            annotationKind={annotationKind}
            color={ANNOTATION_COLOR}
            hitTest={hitTest}
            onPickComment={(id) => {
              setActiveCommentId(id);
              setSidebarOpen(true);
            }}
            onCreateAnnotation={(draft) => void createAnnotation(draft)}
            onDeleteAnnotation={(id) => void removeAnnotation(id)}
            onUpdateAnnotation={(id, points) =>
              void updateAnnotation(id, points)
            }
            onMoveElement={(path, targetPath, position) =>
              void moveElementTo(path, targetPath, position)
            }
          />
        ) : null}
        {pendingComment &&
        viewMode === "preview" &&
        !directPreview &&
        !isMarkdownEntry ? (
          <OpenDesignCommentComposer
            excerpt={pendingComment.text}
            busy={busy}
            onCancel={() => setPendingComment(null)}
            onSubmit={(body) => void createComment(body)}
          />
        ) : null}
        {sidebarOpen && canvas && !directPreview && !isMarkdownEntry ? (
          <OpenDesignCommentSidebar
            comments={review.comments}
            activeId={activeCommentId}
            busy={busy}
            onSelect={setActiveCommentId}
            onToggleResolved={(comment) =>
              void patchComment(comment, {
                status: comment.status === "open" ? "resolved" : "open",
              })
            }
            onDelete={(comment) => void removeComment(comment)}
            onClose={() => {
              setSidebarOpen(false);
              setActiveCommentId(null);
            }}
          />
        ) : null}
        {picked &&
        viewMode === "preview" &&
        !directPreview &&
        !isMarkdownEntry &&
        !activeVersion ? (
          <OpenDesignEditInspector
            key={picked.path}
            hit={picked}
            busy={busy}
            onCancel={() => setPicked(null)}
            onSave={(draft) => void saveEdit(draft)}
          />
        ) : null}
        {resourceView && (phase === "ready" || phase === "empty") ? (
          <div
            data-open-design-resources=""
            className="flex h-full flex-col overflow-auto px-4 py-4"
          >
            <div className="mb-3 flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="新建"
                    title="新建"
                    disabled={busy}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuItem onSelect={() => void createSketch()}>
                    <PenTool className="size-3.5" />
                    <span className="flex-1">新建草图</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void createDocument()}>
                    <FileText className="size-3.5" />
                    <span className="flex-1">新建文档</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void createDesignFile()}>
                    <FigmaMark className="size-3.5" />
                    <span className="flex-1">新建设计稿</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => emptyUploadInputRef.current?.click()}
                  >
                    <Upload className="size-3.5" />
                    <span className="flex-1">上传</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={onOpenBrowserTab}>
                    <Globe className="size-3.5" />
                    <span className="flex-1">新建浏览器</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openDesignSystemCreate}>
                    <Palette className="size-3.5" />
                    <span className="flex-1">新建设计体系</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="text-sm font-medium">设计文件</span>
              <span className="ml-auto text-ui-caption text-foreground-subtle">
                {sketches.length + files.length} 项
              </span>
            </div>
            {sketches.length === 0 && files.length === 0 ? (
              <div
                data-open-design-empty=""
                className="flex flex-1 flex-col items-center justify-center gap-5 text-foreground-subtle"
              >
                <PenTool className="size-9 opacity-30" />
                <p className="text-sm">生成的设计会出现在这里</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-open-design-empty-action="sketch"
                    onClick={() => void createSketch()}
                  >
                    <PenTool className="size-3.5" />
                    新建草图
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-open-design-empty-action="document"
                    onClick={() => void createDocument()}
                  >
                    <FileText className="size-3.5" />
                    新建文档
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-open-design-empty-action="upload"
                    onClick={() => emptyUploadInputRef.current?.click()}
                  >
                    <Upload className="size-3.5" />
                    上传
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-open-design-empty-action="browser"
                    onClick={onOpenBrowserTab}
                  >
                    <Globe className="size-3.5" />
                    新建浏览器
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-open-design-empty-action="design-system"
                    onClick={openDesignSystemCreate}
                  >
                    <Palette className="size-3.5" />
                    新建设计体系
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {sketches.length > 0 ? (
                  <section className="flex flex-col gap-1.5">
                    <span className="text-ui-caption text-foreground-subtle">
                      草图
                    </span>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                      {sketches.map((sketch) => (
                        <button
                          key={sketch.id}
                          type="button"
                          data-open-design-resource="sketch"
                          className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-ui-base hover:bg-surface-hover"
                          onClick={() =>
                            workspaceProjectId &&
                            requestCanvasDocumentOpen({
                              projectId: workspaceProjectId,
                              documentId: sketch.id,
                              title: sketch.name,
                            })
                          }
                        >
                          <PenTool className="size-4 shrink-0 text-foreground-subtle" />
                          <span className="min-w-0 truncate">
                            {sketch.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
                {htmlFiles.length > 0 ? (
                  renderFileSection("设计", htmlFiles)
                ) : (
                  <section className="flex flex-col gap-1.5">
                    <span className="text-ui-caption text-foreground-subtle">
                      设计
                    </span>
                    <p className="text-ui-caption text-foreground-subtle">
                      生成的设计会出现在这里
                    </p>
                  </section>
                )}
                {renderFileSection("文档", markdownFiles)}
                {renderFileSection("资源", otherFiles)}
              </div>
            )}
            <input
              ref={emptyUploadInputRef}
              type="file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadAsset(file);
              }}
            />
          </div>
        ) : null}
        {shareConfigProvider ? (
          <div
            className="absolute inset-0 z-30 flex flex-col gap-3 bg-background p-4"
            data-open-design-share-config-panel=""
          >
            <span className="text-sm font-medium">
              {shareConfigProvider === "cloudflare-pages"
                ? "配置 Cloudflare Pages"
                : "配置 Vercel"}
            </span>
            <label className="flex flex-col gap-1 text-xs">
              {shareConfigProvider === "cloudflare-pages"
                ? "API Token"
                : "Vercel Token"}
              <input
                type="password"
                data-testid="open-design-share-token"
                value={shareConfig.token}
                onChange={(event) =>
                  setShareConfig((current) => ({
                    ...current,
                    token: event.target.value,
                  }))
                }
                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                placeholder="粘贴 token"
              />
            </label>
            {shareConfigProvider === "cloudflare-pages" ? (
              <label className="flex flex-col gap-1 text-xs">
                Account ID
                <input
                  data-testid="open-design-share-account"
                  value={shareConfig.accountId}
                  onChange={(event) =>
                    setShareConfig((current) => ({
                      ...current,
                      accountId: event.target.value,
                    }))
                  }
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  placeholder="Cloudflare 账号 ID"
                />
              </label>
            ) : (
              <label className="flex flex-col gap-1 text-xs">
                Team Slug（可选）
                <input
                  data-testid="open-design-share-team"
                  value={shareConfig.teamSlug}
                  onChange={(event) =>
                    setShareConfig((current) => ({
                      ...current,
                      teamSlug: event.target.value,
                    }))
                  }
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                />
              </label>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={shareBusy}
                data-testid="open-design-share-save"
                onClick={() => void saveShareConfig()}
              >
                保存
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setShareConfigProvider(null)}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}
        {designSystemCreateOpen ? (
          <div
            data-testid="open-design-design-system-create"
            className="absolute inset-0 z-30 flex flex-col bg-background"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="返回"
                title="返回"
                disabled={designSystemCreating}
                onClick={closeDesignSystemCreate}
              >
                <ArrowLeft className="size-3.5" />
              </Button>
              <span className="text-sm font-medium">新建设计体系</span>
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                disabled={!hasDesignSource || designSystemCreating}
                onClick={() => void createDesignSystem()}
              >
                {designSystemCreating ? "生成中…" : "继续生成"}
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
              <section className="flex flex-col gap-2">
                <span className="text-ui-caption text-foreground-subtle">
                  来源
                </span>
                <div className="flex gap-2">
                  <input
                    aria-label="网站链接"
                    placeholder="https://"
                    className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-ui-base outline-none"
                    value={designSourceUrl}
                    maxLength={2048}
                    disabled={designSystemCreating}
                    onChange={(event) => setDesignSourceUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        addDesignSourceUrl();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!designSourceUrl.trim() || designSystemCreating}
                    onClick={addDesignSourceUrl}
                  >
                    添加
                  </Button>
                </div>
                {designSourceUrls.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {designSourceUrls.map((url) => (
                      <span
                        key={url}
                        className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground-subtle"
                      >
                        <span className="max-w-56 truncate">{url}</span>
                        <button
                          type="button"
                          aria-label={`移除 ${url}`}
                          title={`移除 ${url}`}
                          disabled={designSystemCreating}
                          className="rounded-full hover:text-foreground"
                          onClick={() =>
                            setDesignSourceUrls((current) =>
                              current.filter((item) => item !== url),
                            )
                          }
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>
              <label className="flex flex-col gap-1.5">
                <span className="text-ui-caption text-foreground-subtle">
                  描述品牌 · 可选
                </span>
                <textarea
                  aria-label="品牌描述"
                  rows={3}
                  maxLength={2000}
                  placeholder="一句话说明品牌气质和面向的人"
                  className="resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-ui-base outline-none"
                  value={designDescription}
                  disabled={designSystemCreating}
                  onChange={(event) => setDesignDescription(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-ui-caption text-foreground-subtle">
                  粘贴 DESIGN.md · 可选
                </span>
                <textarea
                  aria-label="DESIGN.md"
                  rows={6}
                  maxLength={200_000}
                  placeholder="# 品牌名"
                  className="resize-none rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs outline-none"
                  value={designMarkdown}
                  disabled={designSystemCreating}
                  onChange={(event) => setDesignMarkdown(event.target.value)}
                />
              </label>
              <p className="text-ui-caption text-foreground-subtle">
                网站或 DESIGN.md 至少一项
              </p>
              {designCreateStatus ? (
                <p
                  data-testid="open-design-design-system-status"
                  className="text-ui-caption text-foreground-subtle"
                  role="status"
                >
                  {designCreateStatus}
                </p>
              ) : null}
              {designCreateError ? (
                <p
                  data-testid="open-design-design-system-error"
                  className="text-xs text-destructive"
                  role="alert"
                >
                  {designCreateError}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {designSystems ? (
          <div className="absolute inset-0 z-30 flex flex-col bg-background p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium">选择设计体系</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDesignSystems(null)}
              >
                取消
              </Button>
            </div>
            {designSystems.state === "loading" ? (
              <p className="text-xs">正在读取…</p>
            ) : designSystems.state === "error" ? (
              <p className="text-xs text-destructive">
                {designSystems.message}
              </p>
            ) : (
              <div
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
                data-open-design-system-list=""
              >
                {designSystems.items.map((system) => (
                  <button
                    key={system.id}
                    type="button"
                    data-open-design-system={system.id}
                    className="flex items-center gap-3 rounded-md border px-3 py-2 text-left hover:bg-hover"
                    onClick={() =>
                      void bindDesignSystem(system.id, system.title)
                    }
                  >
                    <span className="flex shrink-0 gap-1">
                      {system.swatches.slice(0, 5).map((swatch) => (
                        <span
                          key={swatch}
                          className="size-3 rounded-full border border-border"
                          style={{ background: swatch }}
                        />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">
                        {system.title}
                      </span>
                      {system.category ? (
                        <span className="block truncate text-[10px] text-foreground-subtle">
                          {system.category}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            )}
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
      <OpenDesignRenameDialog
        target={renamingFile}
        busy={renameBusy}
        onChange={(draft) =>
          setRenamingFile((current) =>
            current ? { ...current, draft } : current,
          )
        }
        onCancel={() => {
          if (!renameBusy) setRenamingFile(null);
        }}
        onSubmit={() => void renameFile()}
      />
      <OpenDesignDeleteDialog
        target={deletingFile}
        busy={deleteBusy}
        onCancel={() => {
          if (!deleteBusy) setDeletingFile(null);
        }}
        onConfirm={() => void deleteFile()}
      />
    </div>
  );
}

/** 容器还没量到尺寸时的截图兜底（面板刚挂载就点截图）。 */
const CAPTURE_FALLBACK_SIZE = { width: 960, height: 640 } as const;
const CAPTURE_MIN_SIDE = 240;

/** 文件名里不能出现的字符（不同文件系统共同禁集，粗收敛即可）。 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|]/g;

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], `${name.replace(UNSAFE_FILENAME_CHARS, "-")}.png`, {
    type: "image/png",
  });
}

/** 上传资源的体积上限：base64 后还要过宿主正文上限，超限直接拒，不半途截断。 */
const UPLOAD_MAX_BYTES = 1.5 * 1024 * 1024;

/** 标注笔迹色：先固定一支红笔，色板留给后续按需再加。 */
const ANNOTATION_COLOR = "#ef4444";

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // 分块转码：单次 String.fromCharCode(...bytes) 在几百 KB 上会爆调用栈。
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
