"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useGenerationErrorHandler } from "../../hooks/use-generation-error-handler";
import {
  getVideoGeneratorData,
  resizeVideoGeneratorElement,
  updateVideoGeneratorElement,
  type VideoGeneratorData,
  type VideoGeneratorParams,
} from "../../lib/canvas-video-generator";
import type { VideoModelInfo } from "../../lib/server-api";
import {
  ApiAccessError,
  ApiApplicationError,
  fetchVideoModels,
  generateVideoDirect,
  getAssetUrl,
  uploadFile,
} from "../../lib/server-api";
import { ModelParameterField } from "./model-parameter-field";

// No longer needs poster frame extraction -- videos use embeddable elements

/**
 * lib 生成器助手（canvas-video-generator）的入参是宽松的结构化接口
 * （`captureUpdate?: string` 等），与 Excalidraw 官方类型在函数参数上互不可比；
 * 运行时传的是同一个 API 对象，故按助手的入参口径断言。
 */
type GeneratorLibApi = Parameters<typeof updateVideoGeneratorElement>[0];
type ReferenceField = "firstFrame" | "lastFrame" | "inputVideo";
type ReferenceUploadState = Partial<
  Record<ReferenceField, "uploading" | "failed" | undefined>
>;

type VideoGeneratorPanelProps = {
  canvasId: string;
  projectId: string;
  prepare: () => Promise<string | null>;
  elementId: string;
  elementBounds: { x: number; y: number; width: number; height: number };
  data: VideoGeneratorData;
  excalidrawApi: ExcalidrawImperativeAPI;
  accessToken: string | null;
  /** 当前画布会话（§4.8）：实例自定义头的 `{{sessionId}}` 按它渲染；无会话时缺省。 */
  sessionId?: string | undefined;
  canvasScrollZoom: { scrollX: number; scrollY: number; zoom: number };
};

function frameLimit(model?: VideoModelInfo): number | undefined {
  if (model?.videoGeneration?.referenceImages !== undefined) {
    return model.videoGeneration.referenceImages;
  }
  if (model?.videoGeneration?.firstLastFrame === true) return undefined;
  if (model?.capabilities?.imageToVideo === false) return 0;
  return model?.limits?.maxInputImages;
}

function audioSupported(model?: VideoModelInfo): boolean | undefined {
  return model?.videoGeneration?.audio ?? model?.capabilities?.audio;
}

function modelParams(
  params: VideoGeneratorParams,
  model?: VideoModelInfo,
  switching = false,
): VideoGeneratorParams {
  const caps = model?.videoGeneration;
  const durations = caps?.durations ?? model?.limits?.allowedDurations;
  const supported = <T,>(value: T | undefined, options?: T[]) =>
    options && !options.some((option) => option === value) ? options[0] : value;
  const next: VideoGeneratorParams = {
    ...params,
    aspectRatio: supported(params.aspectRatio, caps?.aspectRatios),
    duration: supported(params.duration, durations),
    resolution: supported(params.resolution, caps?.resolutions),
    firstFrame: params.firstFrame,
    lastFrame: params.lastFrame,
    inputVideo:
      model?.capabilities?.videoToVideo === false
        ? undefined
        : params.inputVideo,
    enableAudio: params.enableAudio,
  };
  if (switching) {
    if (frameLimit(model) === 0) next.firstFrame = undefined;
    if (
      frameLimit(model) === 0 ||
      frameLimit(model) === 1 ||
      caps?.firstLastFrame === false
    )
      next.lastFrame = undefined;
    if (audioSupported(model) === false) next.enableAudio = undefined;
  }
  return next;
}

export function VideoGeneratorPanel({
  canvasId,
  projectId,
  prepare,
  elementId,
  elementBounds,
  data,
  excalidrawApi,
  accessToken,
  sessionId,
  canvasScrollZoom,
}: VideoGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [params, setParams] = useState<VideoGeneratorParams>(() => ({
    aspectRatio: data.aspectRatio,
    duration: data.duration,
    resolution: data.resolution,
    firstFrame: data.firstFrame ?? data.inputImages?.[0],
    lastFrame: data.lastFrame ?? data.inputImages?.[1],
    inputVideo: data.inputVideo,
    enableAudio: data.enableAudio,
  }));
  const {
    aspectRatio,
    duration,
    resolution,
    firstFrame,
    lastFrame,
    inputVideo,
    enableAudio,
  } = params;
  const modelDraftsRef = useRef(data.modelDrafts ?? {});
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const modelRef = useRef(model);
  modelRef.current = model;
  const [loading, setLoading] = useState(data.status === "generating");
  const [stopping, setStopping] = useState(data.cancelRequested === true);
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  const [models, setModels] = useState<VideoModelInfo[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [referenceUploads, setReferenceUploads] = useState<
    Record<string, ReferenceUploadState>
  >({});
  const uploading = Object.values(referenceUploads[model] ?? {}).includes(
    "uploading",
  );
  const uploadFailed = Object.values(referenceUploads[model] ?? {}).includes(
    "failed",
  );
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showParamsPopover, setShowParamsPopover] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const { handleGenerationError } = useGenerationErrorHandler();
  // AbortController for in-flight generation requests so we can cancel on unmount
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLoading(data.status === "generating");
    setStopping(data.cancelRequested === true);
    setError(data.errorMessage ?? null);
  }, [data.status, data.errorMessage, data.cancelRequested]);

  // Fetch available models with error logging
  useEffect(() => {
    let cancelled = false;
    fetchVideoModels()
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
      })
      .catch((err) => {
        console.warn("[video-gen] Failed to fetch models:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close dropdowns when clicking outside the panel
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
        setShowParamsPopover(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Cancel in-flight generation on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Auto-resize textarea
  // biome-ignore lint/correctness/useExhaustiveDependencies: prompt 只当触发器（高度按 DOM 现量，不读值）；去掉后输入不再自动长高
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [prompt]);

  // Calculate panel screen position from canvas coordinates
  const { scrollX, scrollY, zoom } = canvasScrollZoom;
  const screenX = (elementBounds.x + scrollX) * zoom;
  const screenY = (elementBounds.y + elementBounds.height + scrollY) * zoom + 8;

  const currentModel = models.find((m) => m.id === model);
  const currentPriceRate = currentModel?.pricing?.rates.find(
    (rate) => rate.resolution === resolution,
  );

  const updateParams = useCallback(
    (patch: Partial<VideoGeneratorParams>) => {
      const next = { ...paramsRef.current, ...patch };
      paramsRef.current = next;
      setParams(next);
      modelDraftsRef.current = {
        ...modelDraftsRef.current,
        [modelRef.current]: next,
      };
      if (patch.aspectRatio)
        resizeVideoGeneratorElement(
          excalidrawApi as GeneratorLibApi,
          elementId,
          patch.aspectRatio,
        );
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        ...next,
        modelDrafts: modelDraftsRef.current,
      });
    },
    [excalidrawApi, elementId],
  );

  useEffect(() => {
    if (!currentModel) return;
    const next = modelParams(params, currentModel);
    if (JSON.stringify(next) !== JSON.stringify(params)) updateParams(next);
  }, [currentModel, params, updateParams]);

  const handleModelChange = useCallback(
    (id: string) => {
      const selected = models.find((candidate) => candidate.id === id);
      const next = modelParams(
        modelDraftsRef.current[id] ?? {},
        selected,
        true,
      );
      modelDraftsRef.current = {
        ...modelDraftsRef.current,
        [model]: params,
        [id]: next,
      };
      modelRef.current = id;
      paramsRef.current = next;
      setModel(id);
      setParams(next);
      setShowModelDropdown(false);
      resizeVideoGeneratorElement(
        excalidrawApi as GeneratorLibApi,
        elementId,
        next.aspectRatio ?? "16:9",
      );
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        model: id,
        ...next,
        inputImages: undefined,
        modelDrafts: modelDraftsRef.current,
      });
    },
    [model, params, models, excalidrawApi, elementId],
  );

  useEffect(() => {
    const first = models[0];
    if (
      !first ||
      models.some((candidate) => candidate.id === model) ||
      data.status === "generating"
    )
      return;
    handleModelChange(first.id);
  }, [models, model, data.status, handleModelChange]);

  useEffect(() => {
    let cancelled = false;
    for (const source of [firstFrame, lastFrame, inputVideo]) {
      if (!source?.startsWith("asset://")) continue;
      getAssetUrl(accessTokenRef.current, source.slice("asset://".length))
        .then(({ url }) => {
          if (!cancelled)
            setPreviewUrls((previous) => ({ ...previous, [source]: url }));
        })
        .catch(() => {
          if (!cancelled) setError("参考素材暂时无法读取，请重新添加。");
        });
    }
    return () => {
      cancelled = true;
    };
  }, [firstFrame, lastFrame, inputVideo]);

  const handleReferenceUpload = useCallback(
    (field: ReferenceField) => {
      return async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const uploadModel = modelRef.current;
        modelDraftsRef.current = {
          ...modelDraftsRef.current,
          [uploadModel]: paramsRef.current,
        };
        const updateUpload = (state: "uploading" | "failed" | undefined) => {
          setReferenceUploads((previous) => ({
            ...previous,
            [uploadModel]: { ...previous[uploadModel], [field]: state },
          }));
        };
        updateUpload("uploading");
        setError(null);
        try {
          const saved = await uploadFile(
            accessTokenRef.current,
            file,
            projectId,
          );
          const source = `asset://${saved.asset.id}`;
          setPreviewUrls((previous) => ({ ...previous, [source]: saved.url }));
          const patch = { [field]: source };
          if (modelRef.current === uploadModel) {
            updateParams(patch);
          } else {
            const previous = modelDraftsRef.current[uploadModel];
            modelDraftsRef.current = {
              ...modelDraftsRef.current,
              [uploadModel]: { ...previous, ...patch },
            };
            updateVideoGeneratorElement(
              excalidrawApi as GeneratorLibApi,
              elementId,
              { modelDrafts: modelDraftsRef.current },
            );
          }
          updateUpload(undefined);
        } catch {
          updateUpload("failed");
          if (modelRef.current === uploadModel)
            setError("参考素材上传失败，请重新添加或移除失败项。");
        }
      };
    },
    [projectId, updateParams, excalidrawApi, elementId],
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || loading) return;
    if (uploading || uploadFailed) {
      setError(
        uploading
          ? "参考素材正在上传。"
          : "参考素材上传失败，请重新添加或移除失败项。",
      );
      return;
    }
    if (!currentModel) {
      setError("请选择可用模型。");
      return;
    }
    if (lastFrame && !firstFrame) {
      setError("请先添加首帧，再添加尾帧。");
      return;
    }
    const maxFrames = frameLimit(currentModel);
    if (
      maxFrames !== undefined &&
      Number(Boolean(firstFrame)) + Number(Boolean(lastFrame)) > maxFrames
    ) {
      setError(`最多支持 ${maxFrames} 张参考图`);
      return;
    }
    if (lastFrame && currentModel.videoGeneration?.firstLastFrame === false) {
      setError("此模型不支持尾帧，请移除尾帧或切换模型。");
      return;
    }
    if (enableAudio === true && audioSupported(currentModel) === false) {
      setError("此模型不支持音频，请关闭音频或切换模型。");
      return;
    }
    if (
      duration !== undefined &&
      (!Number.isFinite(duration) || duration <= 0)
    ) {
      setError("请输入有效时长。");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = crypto.randomUUID();
    const activeRequest = () => {
      const active = getVideoGeneratorData(
        excalidrawApi
          .getSceneElements()
          .find((element) => element.id === elementId && !element.isDeleted),
      );
      return active?.requestId === requestId && active.status === "generating"
        ? active
        : null;
    };
    setLoading(true);
    setStopping(false);
    setError(null);
    updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
      status: "generating",
      prompt: prompt.trim(),
      model,
      aspectRatio,
      duration,
      resolution,
      firstFrame,
      lastFrame,
      inputVideo,
      enableAudio,
      requestId,
      jobIds: [],
      cancelRequested: false,
      errorMessage: "",
    });
    let submitted = false;
    try {
      if (!(await prepare())) throw new Error("画布尚未保存，请保存后重试。");
      submitted = true;
      const submission = await generateVideoDirect(
        accessTokenRef.current,
        prompt.trim(),
        {
          requestId,
          projectId,
          canvasId,
          generatorId: elementId,
          placement: elementBounds,
          model,
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution ? { resolution } : {}),
          ...(enableAudio !== undefined ? { enableAudio } : {}),
          inputImages: [firstFrame, lastFrame].filter(
            (source): source is string => Boolean(source),
          ),
          ...(inputVideo ? { inputVideo } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      );
      if (controller.signal.aborted || !activeRequest()) return;
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        requestId: submission.request_id,
        jobIds: submission.jobs.map((job) => job.job_id),
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const active = activeRequest();
      if (!active || active.cancelRequested || active.jobIds?.length) return;
      if (
        submitted &&
        !(error instanceof ApiApplicationError) &&
        !(error instanceof ApiAccessError)
      ) {
        setError("提交结果待确认");
        return;
      }
      const message =
        error instanceof Error ? error.message : "生成任务受理失败，请重试。";
      handleGenerationError(error);
      setError(message);
      setLoading(false);
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        status: "error",
        errorMessage: message,
      });
    }
  }, [
    prompt,
    loading,
    model,
    aspectRatio,
    duration,
    resolution,
    firstFrame,
    lastFrame,
    inputVideo,
    enableAudio,
    uploading,
    uploadFailed,
    sessionId,
    excalidrawApi,
    elementId,
    elementBounds,
    canvasId,
    projectId,
    prepare,
    handleGenerationError,
    currentModel,
  ]);

  const resolutionLabel = currentPriceRate?.displayResolution ?? resolution;
  const paramsLabel =
    [
      aspectRatio,
      duration === undefined ? undefined : `${duration}s`,
      resolutionLabel,
    ]
      .filter(Boolean)
      .join(" · ") || "参数";

  return createPortal(
    <div
      ref={panelRef}
      role="none"
      style={{ left: screenX, top: screenY }}
      className="fixed z-[100] w-[520px] rounded-[24px] border border-border bg-card shadow-card"
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Frame upload area */}
      <div className="flex gap-2 p-2 pb-0">
        {/* First frame */}
        <input
          ref={firstFrameInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="首帧"
          disabled={
            referenceUploads[model]?.firstFrame === "uploading" ||
            frameLimit(currentModel) === 0
          }
          onChange={handleReferenceUpload("firstFrame")}
        />
        <button
          type="button"
          onClick={() => firstFrameInputRef.current?.click()}
          disabled={
            referenceUploads[model]?.firstFrame === "uploading" ||
            frameLimit(currentModel) === 0
          }
          className="flex h-[68px] w-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 transition-colors hover:bg-muted"
        >
          {firstFrame ? (
            // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
            <img
              src={
                previewUrls[firstFrame] ??
                (firstFrame.startsWith("asset://") ? undefined : firstFrame)
              }
              alt="首帧"
              className="h-full w-full rounded-2xl object-cover"
            />
          ) : (
            <>
              <Plus className="h-4 w-4 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">首帧</span>
            </>
          )}
        </button>

        {/* Last frame */}
        <input
          ref={lastFrameInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="尾帧"
          disabled={
            referenceUploads[model]?.lastFrame === "uploading" ||
            frameLimit(currentModel) === 0 ||
            frameLimit(currentModel) === 1 ||
            currentModel?.videoGeneration?.firstLastFrame === false
          }
          onChange={handleReferenceUpload("lastFrame")}
        />
        <button
          type="button"
          onClick={() => lastFrameInputRef.current?.click()}
          disabled={
            referenceUploads[model]?.lastFrame === "uploading" ||
            frameLimit(currentModel) === 0 ||
            frameLimit(currentModel) === 1 ||
            currentModel?.videoGeneration?.firstLastFrame === false
          }
          className="flex h-[68px] w-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 transition-colors hover:bg-muted"
        >
          {lastFrame ? (
            // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
            <img
              src={
                previewUrls[lastFrame] ??
                (lastFrame.startsWith("asset://") ? undefined : lastFrame)
              }
              alt="尾帧"
              className="h-full w-full rounded-2xl object-cover"
            />
          ) : (
            <>
              <Plus className="h-4 w-4 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">尾帧</span>
            </>
          )}
        </button>
        {firstFrame && (
          <button
            type="button"
            className="text-xs text-muted-foreground"
            disabled={referenceUploads[model]?.firstFrame === "uploading"}
            onClick={() => updateParams({ firstFrame: undefined })}
          >
            移除首帧
          </button>
        )}
        {lastFrame && (
          <button
            type="button"
            className="text-xs text-muted-foreground"
            disabled={referenceUploads[model]?.lastFrame === "uploading"}
            onClick={() => updateParams({ lastFrame: undefined })}
          >
            移除尾帧
          </button>
        )}
        {uploading && (
          <span
            role="status"
            className="self-center text-xs text-muted-foreground"
          >
            上传中
          </span>
        )}
        {uploadFailed && (
          <button
            type="button"
            className="text-xs text-muted-foreground"
            onClick={() => {
              setReferenceUploads((previous) => ({
                ...previous,
                [model]: Object.fromEntries(
                  Object.entries(previous[model] ?? {}).filter(
                    ([, state]) => state !== "failed",
                  ),
                ),
              }));
              setError(null);
            }}
          >
            移除失败项
          </button>
        )}
      </div>

      {currentModel?.capabilities?.videoToVideo !== false && (
        <div className="flex items-center gap-2 px-4 pt-2">
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            aria-label="参考视频文件"
            className="hidden"
            disabled={referenceUploads[model]?.inputVideo === "uploading"}
            onChange={handleReferenceUpload("inputVideo")}
          />
          <button
            type="button"
            disabled={referenceUploads[model]?.inputVideo === "uploading"}
            onClick={() => videoInputRef.current?.click()}
            className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed"
          >
            参考视频
          </button>
          {inputVideo && (
            <>
              {/* biome-ignore lint/a11y/useMediaCaption: 用户上传的参考视频未提供字幕轨。 */}
              <video
                aria-label="参考视频预览"
                src={
                  previewUrls[inputVideo] ??
                  (inputVideo.startsWith("asset://") ? undefined : inputVideo)
                }
                controls
                preload="metadata"
                className="max-h-28 min-w-0 flex-1 rounded-lg"
              />
              <button
                type="button"
                disabled={referenceUploads[model]?.inputVideo === "uploading"}
                onClick={() => updateParams({ inputVideo: undefined })}
                className="shrink-0 text-xs text-muted-foreground disabled:cursor-not-allowed"
              >
                移除视频
              </button>
            </>
          )}
        </div>
      )}

      {/* Prompt textarea */}
      <div className="px-4 py-3">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // 输入法组合态的 Enter 是上屏不是生成（isComposing + 229 双信号）
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              void handleGenerate();
            }
          }}
          placeholder="今天我们要创作什么"
          disabled={loading}
          style={{ scrollbarWidth: "none" }}
          className="min-h-[44px] max-h-[140px] w-full resize-none border-none bg-transparent text-[14px] leading-[22px] text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-scrollbar]:hidden"
        />
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      {currentPriceRate && (
        <div className="mx-4 mb-2 text-[10px] tabular-nums text-muted-foreground">
          {currentPriceRate.displayResolution} ·{" "}
          {currentPriceRate.providerPointsPerSecond}
          {" H3积分/秒 · 约 ¥"}
          {currentPriceRate.cnyPerSecond.min.toFixed(4)}–¥
          {currentPriceRate.cnyPerSecond.max.toFixed(4)}/秒
        </div>
      )}

      {/* Bottom toolbar */}
      <div className="flex items-center justify-between px-2 pb-2">
        {/* Left: params button */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowParamsPopover((v) => !v)}
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
          >
            <span className="text-foreground">{paramsLabel}</span>
            <svg
              aria-hidden="true"
              className="h-3 w-3 text-muted-foreground"
              viewBox="0 0 12 24"
              fill="currentColor"
            >
              <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
            </svg>
          </button>
          {showParamsPopover && (
            <div className="absolute bottom-full left-0 z-50 mb-1 flex w-[240px] flex-col gap-2 rounded-xl border-[0.5px] border-border bg-card p-3 shadow-card">
              <ModelParameterField
                label="画幅"
                value={aspectRatio ?? ""}
                options={currentModel?.videoGeneration?.aspectRatios}
                onChange={(value) => updateParams({ aspectRatio: value })}
              />
              <ModelParameterField
                label="时长"
                value={duration === undefined ? "" : String(duration)}
                options={(
                  currentModel?.videoGeneration?.durations ??
                  currentModel?.limits?.allowedDurations
                )?.map(String)}
                numeric
                onChange={(value) =>
                  updateParams({ duration: value ? Number(value) : undefined })
                }
              />
              <ModelParameterField
                label="分辨率"
                value={resolution ?? ""}
                options={currentModel?.videoGeneration?.resolutions}
                onChange={(value) => updateParams({ resolution: value })}
              />
              <label className="flex items-center justify-between text-xs text-muted-foreground">
                音频
                <input
                  aria-label="音频"
                  type="checkbox"
                  checked={enableAudio ?? false}
                  disabled={
                    audioSupported(currentModel) === false && !enableAudio
                  }
                  onChange={(event) =>
                    updateParams({ enableAudio: event.target.checked })
                  }
                />
              </label>
            </div>
          )}
        </div>

        {/* Right: model selector + generate */}
        <div className="flex items-center gap-1">
          {/* Model selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowModelDropdown((v) => !v)}
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              {currentModel?.iconUrl && (
                // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
                <img
                  src={currentModel.iconUrl}
                  alt=""
                  className="h-3.5 w-3.5 rounded-full"
                />
              )}
              <span className="text-foreground">
                {currentModel?.displayName ?? "选择模型"}
              </span>
              <svg
                aria-hidden="true"
                className="h-3 w-3 text-muted-foreground"
                viewBox="0 0 12 24"
                fill="currentColor"
              >
                <path d="M8.546 10.33a.4.4 0 0 1 .566 0l.424.424a.4.4 0 0 1 0 .566l-3.041 3.041a.7.7 0 0 1-.99 0l-3.04-3.04a.4.4 0 0 1 0-.567l.423-.424a.4.4 0 0 1 .567 0L6 12.876z" />
              </svg>
            </button>
            {showModelDropdown && (
              <div className="absolute bottom-full right-0 z-50 mb-1 max-h-[280px] w-[260px] overflow-y-auto rounded-xl border-[0.5px] border-border bg-card py-1 shadow-card">
                {models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleModelChange(m.id)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted ${m.id === model ? "bg-muted" : ""}`}
                  >
                    {m.iconUrl && (
                      // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
                      <img
                        src={m.iconUrl}
                        alt=""
                        className="h-3.5 w-3.5 rounded-full"
                      />
                    )}
                    <span className="flex-1 text-foreground">
                      {m.displayName}
                    </span>
                    {m.id === model && (
                      <svg
                        aria-hidden="true"
                        className="h-3 w-3 text-foreground"
                        viewBox="0 0 14 14"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M12.08 3.087a.583.583 0 0 1 0 .825L5.661 10.33a.583.583 0 0 1-.824 0L1.92 7.412a.583.583 0 0 1 .825-.825L5.25 9.092l6.004-6.005a.583.583 0 0 1 .825 0"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {loading && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                updateVideoGeneratorElement(
                  excalidrawApi as GeneratorLibApi,
                  elementId,
                  { cancelRequested: true },
                );
              }}
              className="h-8 rounded-full px-3 text-xs text-muted-foreground hover:bg-muted disabled:cursor-not-allowed"
            >
              {stopping ? "停止中" : "停止"}
            </button>
          )}
          {/* Generate button */}
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={
              !prompt.trim() ||
              loading ||
              uploading ||
              uploadFailed ||
              !currentModel
            }
            className="flex h-8 items-center justify-center gap-1 rounded-full bg-primary px-3 text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {loading ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-primary-foreground/30 border-t-primary-foreground dark:border-primary-foreground/30 dark:border-t-primary-foreground" />
            ) : (
              <svg
                aria-hidden="true"
                className="h-3.5 w-[9.3px] shrink-0"
                viewBox="0 0 8 10"
                fill="currentColor"
              >
                <path d="M6.9 4.36H5.385V.76c0-.84-.447-1.01-.991-.38L4 .835.677 4.685c-.457.525-.265.955.422.955h1.517v3.6c0 .84.446 1.01.991.38L4 9.165l3.323-3.85c.456-.525.265-.955-.422-.955" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
