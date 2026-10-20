import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DesignReviewAnnotation,
  DesignReviewComment,
} from "@kenfutwork/shared";
import { Button } from "@zui/components/ui/button.js";
import { dispatchOpenDesignCanvasAddToChat } from "@zui/lib/openDesignCanvasChat.js";
import type { OpenDesignSidePaneMetadata } from "@zui/lib/workspaceSidePane.js";
import {
  ZCodeStartupLogoBadge,
  ZCodeStartupSpinner,
} from "@zui/root/RootStartupLoading.js";
import { rasterizeDesignHtml } from "./openDesignCapture.js";
import {
  OpenDesignCommentComposer,
  OpenDesignCommentSidebar,
} from "./OpenDesignCommentSidebar.js";
import {
  OpenDesignEditInspector,
  type OpenDesignEditDraft,
} from "./OpenDesignEditInspector.js";
import { OpenDesignMarkup } from "./OpenDesignMarkup.js";
import type { FrameMetrics, OverlayBox } from "./openDesignMarkupGeometry.js";
import {
  buildCanvasDocument,
  type OpenDesignHit,
} from "./openDesignRuntime.js";
import { applyElementEdit } from "./openDesignSourceEdit.js";
import { useOpenDesignBridge } from "./useOpenDesignBridge.js";
import { useOpenDesignEntry } from "./openDesignHost.js";
import {
  OpenDesignToolbar,
  type OpenDesignCanvasSummary,
  type OpenDesignTool,
  type OpenDesignVersionSummary,
  type OpenDesignViewMode,
  type OpenDesignViewport,
} from "./OpenDesignToolbar.js";
import { surfaceJson } from "./surfaceApi.js";

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
  onMeta,
  workspacePath,
  workspaceIdentity,
  onOpenBrowserTab,
}: {
  /** 侧栏标签 id：画布名/绑定回写按它记账。 */
  tabId: string;
  /** 绑定的画布（上游项目 id）；null = 未绑定，面板解析「最近画布」。 */
  projectId: string | null;
  onMeta: (tabId: string, metadata: OpenDesignSidePaneMetadata) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 「+」里的「新建浏览器」：开侧栏浏览器标签（与画布标签同位）。 */
  onOpenBrowserTab: () => void;
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
  const [viewMode, setViewMode] = useState<OpenDesignViewMode>("preview");
  const [viewport, setViewport] = useState<OpenDesignViewport>("desktop");
  const [zoom, setZoom] = useState<number>(100);
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [currentText, setCurrentText] = useState<string | null>(null);
  const [versions, setVersions] = useState<OpenDesignVersionSummary[] | null>(
    null,
  );
  const [openableCanvases, setOpenableCanvases] = useState<
    OpenDesignCanvasSummary[]
  >([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
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
      setNotice(null);
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
        setNotice(
          createError instanceof Error
            ? createError.message
            : "评论失败。",
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
        setNotice(
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
    async (draft: { kind: "pen"; points: [number, number][] }) => {
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
        setNotice(
          drawError instanceof Error ? drawError.message : "保存标注失败。",
        );
      }
    },
    [canvas],
  );

  const removeAnnotation = useCallback(
    async (id: string) => {
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
        setNotice(
          eraseError instanceof Error
            ? eraseError.message
            : "删除标注失败。",
        );
      }
    },
    [],
  );

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

  const loadCurrentText = useCallback(async (): Promise<string | null> => {
    if (!canvas?.entryFile) return null;
    try {
      const data = await surfaceJson<{ text: string }>(
        `/api/open-design/host/file-text?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}`,
      );
      setCurrentText(data.text);
      return data.text;
    } catch (loadError) {
      setNotice(
        loadError instanceof Error ? loadError.message : "读取设计文件失败。",
      );
      return null;
    }
  }, [canvas]);

  const loadCanvas = useCallback(
    async (id: string): Promise<string | null> => {
      setPhase("loading");
      setError(null);
      setActiveVersion(null);
      setCurrentText(null);
      setVersions(null);
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
    setNotice(null);
    const file = await loadCanvas(boundProjectId);
    if (file) await loadPreview(boundProjectId, file);
    setBusy(false);
  }, [boundProjectId, loadCanvas, loadPreview]);

  const createCanvas = useCallback(async (): Promise<string | null> => {
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
      setOpenableCanvases((current) => [
        { projectId: created.project.projectId, name: created.project.name },
        ...current.filter((item) => item.projectId !== created.project.projectId),
      ]);
      return created.project.projectId;
    } catch (createError) {
      setNotice(
        createError instanceof Error ? createError.message : "新建画布失败。",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, [reportMeta]);

  /** 「+」的「打开画布」清单：上游 project 概要（本机 daemon，一次小请求）。 */
  const loadCanvases = useCallback(async () => {
    try {
      const data = await surfaceJson<{
        projects: Array<{ projectId: string; name: string }>;
      }>("/api/open-design/host/projects");
      setOpenableCanvases(data.projects);
    } catch {
      // 清单读不到不影响当前画布：菜单只剩「新建画布」，不报错挡路。
    }
  }, []);

  useEffect(() => {
    if (!entryAvailable) return;
    void loadCanvases();
  }, [entryAvailable, loadCanvases]);

  /** 本标签切到另一块画布（一块画布一个标签；这里只动当前标签的绑定）。 */
  const openCanvas = useCallback(
    (id: string) => {
      if (id === boundProjectId) return;
      setCanvas(null);
      setPreview(null);
      setBoundProjectId(id);
      reportMeta({ projectId: id, title: null });
    },
    [boundProjectId, reportMeta],
  );

  /** 上传资源：二进制走 base64 经宿主写进画布目录；没有画布就先建一块。 */
  const uploadAsset = useCallback(
    async (file: File) => {
      if (file.size > UPLOAD_MAX_BYTES) {
        setNotice("文件超过 1.5 MB，请换小一点的资源。");
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const target = boundProjectId ?? (await createCanvas());
        if (!target) return;
        const content = await fileToBase64(file);
        await surfaceJson("/api/open-design/host/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: target,
            name: file.name.replace(UNSAFE_FILENAME_CHARS, "-"),
            content,
            encoding: "base64",
          }),
        });
        // 先刷新再报成功：refresh 会清 notice，反过来写会让提示刚出现就被抹掉。
        if (target === boundProjectId) await refresh();
        setNotice(`已上传 ${file.name}`);
      } catch (uploadError) {
        setNotice(
          uploadError instanceof Error ? uploadError.message : "上传失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [boundProjectId, createCanvas, refresh],
  );

  /** 保存可视化编辑：改动落到源文本，再由源文本重挂文档。 */
  const saveEdit = useCallback(
    async (draft: OpenDesignEditDraft) => {
      if (!picked || !canvas?.entryFile || currentText === null) return;
      const style: { backgroundColor?: string; color?: string } = {};
      if (draft.color) style.color = draft.color;
      if (draft.backgroundColor) style.backgroundColor = draft.backgroundColor;
      const next = applyElementEdit(currentText, {
        path: picked.path,
        ...(draft.html === picked.html ? {} : { html: draft.html }),
        ...(Object.keys(style).length > 0 ? { style } : {}),
      });
      if (next === null) {
        setNotice("这个元素已经不在当前正文里，改动没有保存。");
        return;
      }
      setBusy(true);
      setNotice(null);
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
        setNotice("已保存");
      } catch (saveError) {
        setNotice(
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
      setNotice("画布还没有内容");
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
    setNotice(null);
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

  /** 交给对话（上游 Handoff 的本地化）：把设计文件本身作为附件送进 composer。 */
  const handoffToChat = useCallback(async () => {
    setBusy(true);
    setNotice(null);
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
      if (!delivered) setNotice("先点一下对话输入框");
    } catch (handoffError) {
      setNotice(
        handoffError instanceof Error ? handoffError.message : "交接失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [canvas, resolveActiveHtml, workspaceIdentity, workspacePath]);

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

  const exportHtml = useCallback(async () => {
    setBusy(true);
    setNotice(null);
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
      setNotice(
        exportError instanceof Error ? exportError.message : "导出失败。",
      );
    } finally {
      setBusy(false);
    }
  }, [canvas, resolveActiveHtml]);

  const share = useCallback(async () => {
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

  const loadVersions = useCallback(async () => {
    if (!canvas?.entryFile || versionsLoading) return;
    setVersionsLoading(true);
    try {
      const data = await surfaceJson<{ versions: OpenDesignVersionSummary[] }>(
        `/api/open-design/host/versions?projectId=${encodeURIComponent(canvas.projectId)}&file=${encodeURIComponent(canvas.entryFile)}`,
      );
      setVersions(data.versions);
    } catch (loadError) {
      setNotice(
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
      setNotice(null);
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
        setNotice(
          loadError instanceof Error ? loadError.message : "读取历史版本失败。",
        );
      } finally {
        setBusy(false);
      }
    },
    [canvas],
  );

  // 版本列表随画布就绪即取（本机 daemon，一次小请求）：菜单打开不再夹带请求，
  // 避免展开瞬间的 state 更新干扰菜单自身的焦点/开合。
  useEffect(() => {
    if (phase !== "ready" || !canvas?.entryFile || versions !== null) return;
    void loadVersions();
  }, [canvas?.entryFile, loadVersions, phase, versions]);

  const frameSize =
    viewport === "tablet"
      ? { width: 820, height: 1180 }
      : viewport === "mobile"
        ? { width: 390, height: 844 }
        : null;
  const scale = zoom / 100;
  const captureReady = phase === "ready" && Boolean(canvas?.entryFile);
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

  return (
    <div
      data-testid="open-design-pane"
      className="flex h-full w-full flex-col bg-background"
    >
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
        commentCount={
          review.comments.filter((item) => item.status === "open").length
        }
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        openableCanvases={openableCanvases}
        onCreateCanvas={() => void createCanvas()}
        onOpenCanvas={openCanvas}
        onUploadAsset={(file) => void uploadAsset(file)}
        onOpenBrowserTab={onOpenBrowserTab}
        versions={versions}
        versionsLoading={versionsLoading}
        activeVersionId={activeVersion?.id ?? null}
        onSelectVersion={(id) => void selectVersion(id)}
        onRefresh={() => void refresh()}
        onScreenshot={() => void screenshotToChat()}
        onHandoff={() => void handoffToChat()}
        onExportPng={() => void exportPng()}
        onExportHtml={() => void exportHtml()}
        onShare={() => void share()}
      />
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
            onClick={() => void selectVersion(null)}
          >
            回到当前
          </Button>
        </div>
      ) : null}
      <div
        ref={frameWrapRef}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        {showCanvas && viewMode === "code" ? (
          <pre
            data-testid="open-design-source"
            className="m-0 h-full overflow-auto whitespace-pre-wrap break-words bg-background p-3 font-mono text-xs text-foreground"
          >
            {activeVersion?.text ?? currentText ?? "读取中…"}
          </pre>
        ) : null}
        {showCanvas && viewMode === "preview" ? (
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
        {showCanvas && viewMode === "preview" && overlayBox && docSize ? (
          <OpenDesignMarkup
            comments={review.comments}
            annotations={review.annotations}
            rects={rects}
            box={overlayBox}
            metrics={docSize}
            drawing={tool === "annotate"}
            color={ANNOTATION_COLOR}
            onPickComment={(id) => {
              setActiveCommentId(id);
              setSidebarOpen(true);
            }}
            onCreateAnnotation={(draft) => void createAnnotation(draft)}
            onDeleteAnnotation={(id) => void removeAnnotation(id)}
          />
        ) : null}
        {pendingComment && viewMode === "preview" ? (
          <OpenDesignCommentComposer
            excerpt={pendingComment.text}
            busy={busy}
            onCancel={() => setPendingComment(null)}
            onSubmit={(body) => void createComment(body)}
          />
        ) : null}
        {sidebarOpen && canvas ? (
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
        {picked && viewMode === "preview" && !activeVersion ? (
          <OpenDesignEditInspector
            key={picked.path}
            hit={picked}
            busy={busy}
            onCancel={() => setPicked(null)}
            onSave={(draft) => void saveEdit(draft)}
          />
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