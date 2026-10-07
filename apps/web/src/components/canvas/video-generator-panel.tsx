"use client";

import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { VideoResolution } from "@kenfutwork/shared";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useGenerationErrorHandler } from "../../hooks/use-generation-error-handler";
import {
  resizeVideoGeneratorElement,
  updateVideoGeneratorElement,
  type VideoGeneratorData,
} from "../../lib/canvas-video-generator";
import type { VideoModelInfo } from "../../lib/server-api";
import {
  fetchJob,
  fetchVideoModels,
  generateVideoDirect,
} from "../../lib/server-api";

// No longer needs poster frame extraction -- videos use embeddable elements

/**
 * lib 生成器助手（canvas-video-generator）的入参是宽松的结构化接口
 * （`captureUpdate?: string` 等），与 Excalidraw 官方类型在函数参数上互不可比；
 * 运行时传的是同一个 API 对象，故按助手的入参口径断言。
 */
type GeneratorLibApi = Parameters<typeof updateVideoGeneratorElement>[0];

type VideoGeneratorPanelProps = {
  elementId: string;
  elementBounds: { x: number; y: number; width: number; height: number };
  data: VideoGeneratorData;
  excalidrawApi: ExcalidrawImperativeAPI;
  accessToken: string | null;
  /** 当前画布会话（§4.8）：实例自定义头的 `{{sessionId}}` 按它渲染；无会话时缺省。 */
  sessionId?: string | undefined;
  canvasScrollZoom: { scrollX: number; scrollY: number; zoom: number };
  onClose: () => void;
};

const ASPECT_RATIOS = ["16:9", "9:16"] as const;
const DURATIONS = [4, 5, 6, 8] as const;
const VIDEO_RESOLUTIONS = ["720p", "1080p", "4k"] as const;

function supportedResolutions(
  model?: VideoModelInfo,
): readonly VideoResolution[] {
  const max = model?.limits?.maxResolution;
  if (max === "2160p") return VIDEO_RESOLUTIONS;
  if (max === "1080p") return VIDEO_RESOLUTIONS.slice(0, 2);
  return VIDEO_RESOLUTIONS.slice(0, 1);
}

export function VideoGeneratorPanel({
  elementId,
  elementBounds,
  data,
  excalidrawApi,
  accessToken,
  sessionId,
  canvasScrollZoom,
  onClose,
}: VideoGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [aspectRatio, setAspectRatio] = useState(data.aspectRatio);
  const [duration, setDuration] = useState(data.duration);
  const [resolution, setResolution] = useState(data.resolution);
  const [loading, setLoading] = useState(data.status === "generating");
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  const [models, setModels] = useState<VideoModelInfo[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showParamsPopover, setShowParamsPopover] = useState(false);
  const [firstFrame, setFirstFrame] = useState<{
    dataUrl: string;
    file: File;
  } | null>(null);
  const [lastFrame, setLastFrame] = useState<{
    dataUrl: string;
    file: File;
  } | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstFrameInputRef = useRef<HTMLInputElement>(null);
  const lastFrameInputRef = useRef<HTMLInputElement>(null);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const { handleGenerationError } = useGenerationErrorHandler();
  // AbortController for in-flight generation requests so we can cancel on unmount
  const abortRef = useRef<AbortController | null>(null);

  // Fetch available models with error logging
  useEffect(() => {
    let cancelled = false;
    fetchVideoModels()
      .then((r) => {
        if (cancelled) return;
        setModels(r.models);
        setModel((current) => {
          if (r.models.length === 0 || r.models.some((m) => m.id === current)) {
            return current;
          }
          const fallback = r.models[0];
          if (!fallback) return current;
          const fallbackId = fallback.id;
          updateVideoGeneratorElement(
            excalidrawApi as GeneratorLibApi,
            elementId,
            {
              model: fallbackId,
            },
          );
          return fallbackId;
        });
      })
      .catch((err) => {
        console.warn("[video-gen] Failed to fetch models:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [excalidrawApi, elementId]);

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
  const durationOptions = currentModel?.limits?.allowedDurations ?? DURATIONS;
  const resolutionOptions = supportedResolutions(currentModel);
  const currentPriceRate = currentModel?.pricing?.rates.find(
    (rate) => rate.resolution === resolution,
  );

  const handleAspectRatioChange = useCallback(
    (ratio: string) => {
      setAspectRatio(ratio);
      resizeVideoGeneratorElement(
        excalidrawApi as GeneratorLibApi,
        elementId,
        ratio,
      );
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        aspectRatio: ratio,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleDurationChange = useCallback(
    (d: number) => {
      setDuration(d);
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        duration: d,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleResolutionChange = useCallback(
    (value: VideoResolution) => {
      setResolution(value);
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        resolution: value,
      });
    },
    [excalidrawApi, elementId],
  );

  const handleModelChange = useCallback(
    (m: string) => {
      const selected = models.find((candidate) => candidate.id === m);
      const nextDurations: readonly number[] =
        selected?.limits?.allowedDurations ?? DURATIONS;
      const nextDuration = nextDurations.includes(duration)
        ? duration
        : (nextDurations[0] ?? duration);
      const nextResolutions = supportedResolutions(selected);
      const nextResolution = nextResolutions.includes(
        resolution as VideoResolution,
      )
        ? (resolution as VideoResolution)
        : (nextResolutions[0] ?? "720p");
      setModel(m);
      setDuration(nextDuration);
      setResolution(nextResolution);
      setShowModelDropdown(false);
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        model: m,
        duration: nextDuration,
        resolution: nextResolution,
      });
    },
    [duration, excalidrawApi, elementId, models, resolution],
  );

  const handleFrameUpload = useCallback(
    (
      _type: "first" | "last",
      setter: React.Dispatch<
        React.SetStateAction<{ dataUrl: string; file: File } | null>
      >,
    ) => {
      return (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          setter({ dataUrl: reader.result as string, file });
        };
        reader.readAsDataURL(file);
        e.target.value = "";
      };
    },
    [],
  );

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim() || loading) return;

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
      status: "generating",
      prompt: prompt.trim(),
      model,
      aspectRatio,
      duration,
      resolution,
    });

    try {
      const inputImages: string[] = [];
      if (firstFrame) inputImages.push(firstFrame.dataUrl);
      if (lastFrame) inputImages.push(lastFrame.dataUrl);

      // S6：受理即返回（202），任务由 worker 异步执行——前端轮询 job 到终态
      const submission = await generateVideoDirect(
        accessTokenRef.current,
        prompt.trim(),
        {
          model,
          duration,
          resolution,
          aspectRatio,
          ...(inputImages.length ? { inputImages } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      );

      // Check if this generation was cancelled while awaiting
      if (controller.signal.aborted) return;

      const POLL_INTERVAL_MS = 3000;
      const MAX_WAIT_MS = 10 * 60 * 1000;
      const pollStartedAt = Date.now();
      let terminal: {
        url: string;
        assetId: string;
        mimeType: string;
        durationSeconds: number;
      } | null = null;
      let terminalError: string | null = null;
      while (Date.now() - pollStartedAt < MAX_WAIT_MS) {
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (controller.signal.aborted) return;
        const response = await fetchJob(
          accessTokenRef.current,
          submission.job_id,
        );
        const current = response.job;
        if (
          current.status === "succeeded" &&
          current.result &&
          typeof current.result.signed_url === "string"
        ) {
          terminal = {
            url: current.result.signed_url as string,
            assetId: current.result.asset_id as string,
            mimeType:
              typeof current.result.mime_type === "string"
                ? current.result.mime_type
                : "video/mp4",
            durationSeconds:
              typeof current.result.duration_seconds === "number"
                ? current.result.duration_seconds
                : 0,
          };
          break;
        }
        if (
          current.status === "failed" ||
          current.status === "dead_letter" ||
          current.status === "canceled"
        ) {
          terminalError =
            typeof current.error_message === "string"
              ? current.error_message
              : `任务终态：${current.status}`;
          break;
        }
      }
      if (controller.signal.aborted) return;
      if (!terminal) {
        throw new Error(
          terminalError ??
            "视频生成超时（10 分钟）仍未完成，请稍后在任务列表查看",
        );
      }
      const result = terminal;

      // Create embeddable element for inline video playback on canvas.
      // Dynamic import -- excalidraw is client-only.
      const { convertToExcalidrawElements } = await import(
        "@excalidraw/excalidraw"
      );
      if (controller.signal.aborted) return;

      const newElements = convertToExcalidrawElements([
        // 只给必要字段，其余（id/颜色/版本号…）由 convertToExcalidrawElements 补全；
        // 骨架类型是「完整元素」口径，装不下这种部分元素，故双重断言到骨架类型。
        {
          type: "embeddable",
          link: result.url,
          x: elementBounds.x,
          y: elementBounds.y,
          width: elementBounds.width,
          height: elementBounds.height,
          customData: {
            isVideo: true,
            mimeType: result.mimeType,
            durationSeconds: result.durationSeconds,
            title: prompt.trim().slice(0, 60),
            prompt: prompt.trim(),
          },
        } as unknown as ExcalidrawElementSkeleton,
      ]);

      // Replace generator placeholder with video embeddable element
      const elements = excalidrawApi
        .getSceneElements()
        .map((el) => (el.id === elementId ? { ...el, isDeleted: true } : el));
      excalidrawApi.updateScene({
        elements: [...elements, ...newElements],
        captureUpdate: "IMMEDIATELY",
      });

      onClose();
    } catch (err) {
      // Ignore aborted requests (user cancelled or component unmounted)
      if (controller.signal.aborted) return;

      console.error("[video-gen] Generation error:", err);
      const handled = handleGenerationError(err);
      if (!handled) {
        setError("视频生成失败，请重试或更换模型。");
      }
      setLoading(false);
      updateVideoGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        status: "error",
        errorMessage: "生成失败",
      });
    }
  }, [
    prompt,
    loading,
    model,
    aspectRatio,
    duration,
    resolution,
    sessionId,
    firstFrame,
    lastFrame,
    excalidrawApi,
    elementId,
    elementBounds,
    onClose,
    handleGenerationError,
  ]);

  const resolutionLabel = currentPriceRate?.displayResolution ?? resolution;
  const paramsLabel = `${aspectRatio} \u00B7 ${duration}s \u00B7 ${resolutionLabel}`;

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
          onChange={handleFrameUpload("first", setFirstFrame)}
        />
        <button
          type="button"
          onClick={() => firstFrameInputRef.current?.click()}
          className="flex h-[68px] w-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 transition-colors hover:bg-muted"
        >
          {firstFrame ? (
            // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
            <img
              src={firstFrame.dataUrl}
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
          onChange={handleFrameUpload("last", setLastFrame)}
        />
        <button
          type="button"
          onClick={() => lastFrameInputRef.current?.click()}
          className="flex h-[68px] w-[56px] flex-col items-center justify-center gap-1 rounded-2xl bg-muted/60 transition-colors hover:bg-muted"
        >
          {lastFrame ? (
            // biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用
            <img
              src={lastFrame.dataUrl}
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
      </div>

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
            <div className="absolute bottom-full left-0 z-50 mb-1 w-[220px] rounded-xl border-[0.5px] border-border bg-card p-3 shadow-card">
              {/* Aspect ratio row */}
              <div className="mb-3">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Aspect Ratio
                </div>
                <div className="flex gap-1">
                  {ASPECT_RATIOS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => handleAspectRatioChange(r)}
                      className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                        r === aspectRatio
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {/* Duration row */}
              <div>
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Duration
                </div>
                <div className="flex flex-wrap gap-1">
                  {durationOptions.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => handleDurationChange(d)}
                      className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                        d === duration
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60"
                      }`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>
              {/* Resolution row */}
              <div className="mt-3">
                <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Resolution
                </div>
                <div className="flex gap-1">
                  {resolutionOptions.map((value) => {
                    const providerLabel = currentModel?.pricing?.rates.find(
                      (rate) => rate.resolution === value,
                    )?.displayResolution;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleResolutionChange(value)}
                        className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                          value === resolution
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted/60"
                        }`}
                      >
                        {providerLabel ?? value}
                      </button>
                    );
                  })}
                </div>
              </div>
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
                {currentModel?.displayName ?? model.split("/").pop()}
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

          {/* Generate button */}
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={!prompt.trim() || loading}
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
