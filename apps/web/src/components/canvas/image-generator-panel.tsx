"use client";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  hasImageGenerationInput,
  type ImageGenerationCaps,
} from "@kenfutwork/shared";
import { ImageUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useGenerationErrorHandler } from "../../hooks/use-generation-error-handler";
import {
  getImageGeneratorData,
  type ImageGeneratorData,
  type ImageGeneratorParams,
  resizeImageGeneratorElement,
  updateImageGeneratorElement,
} from "../../lib/canvas-image-generator";
import type { ImageModelInfo } from "../../lib/server-api";
import {
  ApiAccessError,
  ApiApplicationError,
  fetchImageModels,
  generateImageDirect,
  getAssetUrl,
  uploadFile,
} from "../../lib/server-api";
import { ModelParameterField } from "./model-parameter-field";

type ImageGeneratorPanelProps = {
  canvasId: string;
  projectId: string;
  prepare: () => Promise<string | null>;
  elementId: string;
  elementBounds: { x: number; y: number; width: number; height: number };
  data: ImageGeneratorData;
  excalidrawApi: ExcalidrawImperativeAPI;
  accessToken: string | null;
  /** 当前画布会话（§4.8）：实例自定义头的 `{{sessionId}}` 按它渲染；无会话时缺省。 */
  sessionId?: string | undefined;
  canvasScrollZoom: { scrollX: number; scrollY: number; zoom: number };
};

/**
 * lib 生成器助手（canvas-image-generator）的入参是宽松的结构化接口
 * （`captureUpdate?: string` 等），与 Excalidraw 官方类型在函数参数上互不可比；
 * 运行时传的是同一个 API 对象，故按助手的入参口径断言。
 */
type GeneratorLibApi = Parameters<typeof updateImageGeneratorElement>[0];

function modelParams(
  params: ImageGeneratorParams,
  caps?: ImageGenerationCaps,
): ImageGeneratorParams {
  const supported = (value: string | undefined, options?: string[]) =>
    options && !options.includes(value ?? "") ? options[0] : value;
  return {
    ...params,
    count: params.count ?? 1,
    inputImages: params.inputImages,
    aspectRatio: supported(params.aspectRatio, caps?.aspectRatios) ?? "",
    quality: supported(params.quality, caps?.qualities) ?? "",
    size: supported(params.size, caps?.sizes),
    outputFormat: supported(
      params.outputFormat,
      caps?.outputFormats,
    ) as ImageGeneratorParams["outputFormat"],
  };
}

export function ImageGeneratorPanel({
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
}: ImageGeneratorPanelProps) {
  const [prompt, setPrompt] = useState(data.prompt);
  const [model, setModel] = useState(data.model);
  const [params, setParams] = useState<ImageGeneratorParams>(() => ({
    aspectRatio: data.aspectRatio,
    quality: data.quality,
    size: data.size,
    outputFormat: data.outputFormat,
    inputImages: data.inputImages,
    count: data.count ?? 1,
  }));
  const { aspectRatio, quality, size, outputFormat, count = 1 } = params;
  const modelDraftsRef = useRef(data.modelDrafts ?? {});
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const modelRef = useRef(model);
  modelRef.current = model;
  const [loading, setLoading] = useState(data.status === "generating");
  const [stopping, setStopping] = useState(data.cancelRequested === true);
  const [error, setError] = useState<string | null>(data.errorMessage ?? null);
  const [models, setModels] = useState<ImageModelInfo[]>([]);
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [uploadingModels, setUploadingModels] = useState<
    Record<string, boolean>
  >({});
  const [uploadFailures, setUploadFailures] = useState<Record<string, boolean>>(
    {},
  );
  const refImages = params.inputImages ?? [];
  const uploading = uploadingModels[model] === true;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);
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
    fetchImageModels()
      .then((r) => {
        if (!cancelled) setModels(r.models);
      })
      .catch((err) => {
        console.warn("[image-gen] Failed to fetch models:", err);
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

  const updateParams = useCallback(
    (patch: Partial<ImageGeneratorParams>) => {
      const next = { ...paramsRef.current, ...patch };
      paramsRef.current = next;
      setParams(next);
      modelDraftsRef.current = {
        ...modelDraftsRef.current,
        [modelRef.current]: next,
      };
      if (patch.aspectRatio) {
        resizeImageGeneratorElement(
          excalidrawApi as GeneratorLibApi,
          elementId,
          patch.aspectRatio,
        );
      }
      updateImageGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        ...next,
        modelDrafts: modelDraftsRef.current,
      });
    },
    [excalidrawApi, elementId],
  );

  useEffect(() => {
    if (!currentModel) return;
    const next = modelParams(params, currentModel.imageGeneration);
    if (JSON.stringify(next) !== JSON.stringify(params)) updateParams(next);
  }, [currentModel, params, updateParams]);

  const handleModelChange = useCallback(
    (id: string) => {
      const selected = models.find((candidate) => candidate.id === id);
      const next = modelParams(
        modelDraftsRef.current[id] ?? {
          aspectRatio: "",
          quality: "",
        },
        selected?.imageGeneration,
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
      resizeImageGeneratorElement(
        excalidrawApi as GeneratorLibApi,
        elementId,
        next.aspectRatio,
      );
      updateImageGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        model: id,
        ...next,
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
    for (const source of params.inputImages ?? []) {
      if (!source.startsWith("asset://")) continue;
      getAssetUrl(accessTokenRef.current, source.slice("asset://".length))
        .then(({ url }) => {
          if (!cancelled)
            setPreviewUrls((previous) => ({ ...previous, [source]: url }));
        })
        .catch(() => {
          if (!cancelled) setError("参考图暂时无法读取，请重新添加。");
        });
    }
    return () => {
      cancelled = true;
    };
  }, [params.inputImages]);

  const handleReferenceUpload = useCallback(
    async (files: File[]) => {
      const uploadModel = modelRef.current;
      modelDraftsRef.current = {
        ...modelDraftsRef.current,
        [uploadModel]: paramsRef.current,
      };
      setUploadingModels((previous) => ({ ...previous, [uploadModel]: true }));
      setUploadFailures((previous) => ({ ...previous, [uploadModel]: false }));
      setError(null);
      const results = await Promise.allSettled(
        files.map((file) =>
          uploadFile(accessTokenRef.current, file, projectId),
        ),
      );
      const saved = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const sources = saved.map((result) => `asset://${result.asset.id}`);
      setPreviewUrls((previous) => ({
        ...previous,
        ...Object.fromEntries(
          saved.map((result) => [`asset://${result.asset.id}`, result.url]),
        ),
      }));
      const previous =
        modelRef.current === uploadModel
          ? paramsRef.current
          : modelDraftsRef.current[uploadModel];
      if (previous && sources.length) {
        const inputImages = [...(previous.inputImages ?? []), ...sources];
        if (modelRef.current === uploadModel) updateParams({ inputImages });
        else {
          modelDraftsRef.current = {
            ...modelDraftsRef.current,
            [uploadModel]: { ...previous, inputImages },
          };
          updateImageGeneratorElement(
            excalidrawApi as GeneratorLibApi,
            elementId,
            { modelDrafts: modelDraftsRef.current },
          );
        }
      }
      const failed = results.some((result) => result.status === "rejected");
      setUploadingModels((previous) => ({ ...previous, [uploadModel]: false }));
      setUploadFailures((previous) => ({ ...previous, [uploadModel]: failed }));
      if (failed && modelRef.current === uploadModel)
        setError("参考图上传失败，请重新添加或移除失败项。");
    },
    [projectId, updateParams, excalidrawApi, elementId],
  );

  const handleGenerate = useCallback(async () => {
    if (
      !hasImageGenerationInput(
        prompt,
        refImages,
        currentModel?.imageGeneration,
      ) ||
      loading
    )
      return;
    if (uploading || uploadFailures[model]) {
      setError(
        uploading
          ? "参考图正在上传。"
          : "参考图上传失败，请重新添加或移除失败项。",
      );
      return;
    }
    if (!currentModel) {
      setError("请选择可用模型。");
      return;
    }
    if (!Number.isInteger(count) || count < 1) {
      setError("请输入至少 1 张的整数数量。");
      return;
    }
    if (size && !/^[1-9]\d*x[1-9]\d*$/.test(size)) {
      setError("请输入有效的像素尺寸，例如 1024x1536。");
      return;
    }
    if (
      currentModel.imageGeneration?.maxInputImages !== undefined &&
      refImages.length > currentModel.imageGeneration.maxInputImages
    ) {
      setError(
        `此模型最多支持 ${currentModel.imageGeneration.maxInputImages} 张参考图。`,
      );
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = crypto.randomUUID();
    const activeRequest = () => {
      const active = getImageGeneratorData(
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
    updateImageGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
      status: "generating",
      prompt: prompt.trim(),
      model,
      aspectRatio,
      quality,
      size,
      outputFormat,
      count,
      requestId,
      jobIds: [],
      cancelRequested: false,
      errorMessage: "",
    });
    let submitted = false;
    const finishLocalCancellation = () => {
      if (submitted || !activeRequest()?.cancelRequested) return false;
      setError("已本地停止");
      setLoading(false);
      updateImageGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        status: "error",
        errorMessage: "已本地停止",
      });
      return true;
    };
    try {
      if (!(await prepare())) throw new Error("画布尚未保存，请保存后重试。");
      if (!activeRequest() || finishLocalCancellation()) return;
      submitted = true;
      const submission = await generateImageDirect(
        accessTokenRef.current,
        prompt.trim(),
        {
          requestId,
          projectId,
          canvasId,
          generatorId: elementId,
          placement: elementBounds,
          model,
          count,
          aspectRatio,
          quality,
          ...(size
            ? {
                width: Number(size.split("x")[0]),
                height: Number(size.split("x")[1]),
              }
            : {}),
          ...(outputFormat ? { outputFormat } : {}),
          inputImages: refImages,
          ...(sessionId ? { sessionId } : {}),
        },
      );
      if (controller.signal.aborted || !activeRequest()) return;
      updateImageGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        requestId: submission.request_id,
        jobIds: submission.jobs.map((job) => job.job_id),
      });
    } catch (error) {
      if (finishLocalCancellation()) return;
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
      updateImageGeneratorElement(excalidrawApi as GeneratorLibApi, elementId, {
        status: "error",
        errorMessage: message,
      });
    }
  }, [
    prompt,
    loading,
    model,
    aspectRatio,
    quality,
    size,
    outputFormat,
    count,
    refImages,
    uploading,
    uploadFailures,
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

  return createPortal(
    <div
      ref={panelRef}
      role="none"
      style={{ left: screenX, top: screenY }}
      className="fixed z-[100] w-[450px] rounded-xl border-[0.5px] border-border bg-card p-2 shadow-card"
      onKeyDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* Prompt textarea */}
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
        className="min-h-[74px] max-h-[140px] w-full resize-none border-none bg-transparent p-1 text-[14px] leading-[18px] text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-scrollbar]:hidden"
      />

      {error && (
        <div className="mb-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="mb-2 grid grid-cols-2 gap-2 px-1">
        <ModelParameterField
          label="数量"
          value={String(count)}
          numeric
          onChange={(value) => updateParams({ count: Number(value) })}
        />
        <ModelParameterField
          placeholder="自动"
          label="画幅"
          value={aspectRatio}
          options={currentModel?.imageGeneration?.aspectRatios}
          onChange={(value) => updateParams({ aspectRatio: value })}
        />
        <ModelParameterField
          placeholder="自动"
          label="质量"
          value={quality}
          options={currentModel?.imageGeneration?.qualities}
          onChange={(value) => updateParams({ quality: value })}
        />
        <ModelParameterField
          placeholder="自动"
          label="尺寸"
          value={size ?? ""}
          options={currentModel?.imageGeneration?.sizes}
          onChange={(value) => updateParams({ size: value })}
        />
        <ModelParameterField
          placeholder="自动"
          label="格式"
          value={outputFormat ?? ""}
          options={
            currentModel?.imageGeneration?.outputFormats ?? [
              "",
              "png",
              "jpg",
              "webp",
            ]
          }
          onChange={(value) =>
            updateParams({
              outputFormat: value
                ? (value as ImageGeneratorParams["outputFormat"])
                : undefined,
            })
          }
        />
      </div>

      {/* Bottom toolbar */}
      <div className="mt-1 flex items-center justify-between">
        {/* Left: model + ref image */}
        <div className="flex items-center">
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
              <div className="absolute bottom-full left-0 z-50 mb-1 max-h-[280px] w-[260px] overflow-y-auto rounded-xl border-[0.5px] border-border bg-card py-1 shadow-card">
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

          {/* Reference image upload */}
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            disabled={
              uploading || currentModel?.imageGeneration?.maxInputImages === 0
            }
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void handleReferenceUpload(files);
            }}
          />
          <button
            type="button"
            onClick={() => refInputRef.current?.click()}
            disabled={
              uploading || currentModel?.imageGeneration?.maxInputImages === 0
            }
            className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
              refImages.length > 0
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="添加参考图"
          >
            <ImageUp className="h-3.5 w-3.5" />
          </button>
          {uploading && (
            <span role="status" className="text-xs text-muted-foreground">
              上传中
            </span>
          )}
          {uploadFailures[model] && (
            <button
              type="button"
              className="text-xs text-muted-foreground"
              onClick={() => {
                setUploadFailures((previous) => ({
                  ...previous,
                  [model]: false,
                }));
                setError(null);
              }}
            >
              移除失败项
            </button>
          )}
          {/* Ref image thumbnails */}
          {refImages.length > 0 && (
            <div className="flex items-center gap-1 ml-1">
              {refImages.map((img) => (
                <div key={img} className="relative group">
                  {/* biome-ignore lint/performance/noImgElement: 运行时 URL（data:/blob:/签名），尺寸未知，静态导出（output: "export"）下 next/image 不能用 */}
                  <img
                    src={
                      previewUrls[img] ??
                      (img.startsWith("asset://") ? undefined : img)
                    }
                    alt="ref"
                    className="h-7 w-7 rounded object-cover border border-border"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      updateParams({
                        inputImages: refImages.filter(
                          (source) => source !== img,
                        ),
                      })
                    }
                    className="absolute -top-1 -right-1 hidden group-hover:flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[8px]"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {loading && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                updateImageGeneratorElement(
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
              !hasImageGenerationInput(
                prompt,
                refImages,
                currentModel?.imageGeneration,
              ) ||
              loading ||
              uploading ||
              uploadFailures[model] ||
              !currentModel
            }
            className="flex h-8 min-w-12 items-center justify-center gap-1 rounded-full bg-primary p-2 text-primary-foreground transition-colors hover:bg-primary/80 hover:accent-glow disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          >
            {loading ? (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white" />
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
