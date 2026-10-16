import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type { AvailableVideoModel } from "../../../generation/types.js";
import type { ToolDefinition } from "../../../kernel/types.js";
import type { CanvasDocumentAccess } from "../../canvas/document-access.js";
import { generatedMediaDisplay } from "../media-display.js";
import { mediaReferenceInput } from "../media-reference-input.js";
import type { SubmitVideoJobFn } from "../tool-types.js";

export type { SubmitVideoJobFn } from "../tool-types.js";

/** 当前实例声明优先；旧provider目录继续提供原有的能力与上限。 */
function videoParameterPolicy(model: AvailableVideoModel) {
  const declared = model.videoGeneration;
  return {
    durations: declared?.durations ?? model.limits.allowedDurations,
    maxDuration: declared?.durations ? undefined : model.limits.maxDuration,
    resolutions: declared?.resolutions,
    maxResolution: declared?.resolutions
      ? undefined
      : model.limits.maxResolution,
    aspectRatios: declared?.aspectRatios,
    referenceImages: declared?.referenceImages ?? model.limits.maxInputImages,
    audio: declared?.audio ?? model.capabilities.audio,
  };
}
type VideoParameterPolicy = ReturnType<typeof videoParameterPolicy>;

// ── Dynamic schema builder ─────────────────────────────────────────────────

function buildVideoGenerateSchema(models: AvailableVideoModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds[0];

  const modelDescription = models.length
    ? `Video model to use. Available:\n${models
        .map((model) => {
          const declared = JSON.stringify(videoParameterPolicy(model));
          return `- ${model.id}: ${model.description}${declared === "{}" ? "" : `; ${declared}`}`;
        })
        .join("\n")}`
    : "Model identifier (no video providers currently registered)";

  const modelField =
    modelIds.length >= 1
      ? z
          .enum(modelIds as [string, ...string[]])
          .default(defaultModel as (typeof modelIds)[number])
          .describe(modelDescription)
      : z
          .string()
          .describe(
            "Model identifier（当前未配置任何供应商实例——请先在设置 → 供应商添加）",
          );

  return z.object({
    canvas_id: z
      .uuid({ error: "画布引用无效，请从项目画布列表重新选择。" })
      .optional()
      .describe(
        "Target canvas document in the current project; defaults to the input canvas.",
      ),
    title: z
      .string()
      .min(1)
      .describe(
        "Short descriptive title for the generated video, used as metadata so the video content is understood without re-analysis (e.g. 'Autumn forest bus scene', '恐龙追逐镜头')",
      ),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Detailed video generation prompt. Be specific about motion, camera angles, lighting, mood, action, and scene transitions.",
      ),
    model: modelField,
    duration: z
      .number()
      .positive()
      .optional()
      .describe(
        "Video duration in seconds. Use the selected model's declared durations; omit to use a supported model default when available.",
      ),
    resolution: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Output resolution from the selected model's declarations; omit to use a supported model default when available.",
      ),
    aspectRatio: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Video aspect ratio from the selected model's declarations; omit to use a supported model default when available.",
      ),
    inputImages: z
      .array(z.string())
      .optional()
      .describe(
        "Reference images for models that allow them; respect the selected model's declared referenceImages limit.",
      ),
    inputVideo: z
      .string()
      .optional()
      .describe(
        "Source video URL for video-to-video editing; requires declared reference-video capability.",
      ),
    enableAudio: z
      .boolean()
      .optional()
      .describe(
        "Generate synchronized audio (dialogue, sound effects, ambient). This option is only sent to models that advertise audio capability.",
      ),
    placementX: z
      .number()
      .optional()
      .describe(
        "Canvas X coordinate for video placement. Use inspect_canvas to find a good position.",
      ),
    placementY: z
      .number()
      .optional()
      .describe(
        "Canvas Y coordinate for video placement. Use inspect_canvas to find a good position.",
      ),
    placementWidth: z
      .number()
      .optional()
      .describe("Width on canvas (default: 640)"),
    placementHeight: z
      .number()
      .optional()
      .describe("Height on canvas (default: 360)"),
  });
}

// ── Result type ────────────────────────────────────────────────────────────

// Infer input type from schema — includes the new `title` field
type VideoGenerateInput = z.infer<ReturnType<typeof buildVideoGenerateSchema>>;

function withModelDefaults(
  input: VideoGenerateInput,
  model: AvailableVideoModel,
  policy: VideoParameterPolicy,
): VideoGenerateInput {
  const legacyDurations = model.limits.allowedDurations?.filter(
    (duration) =>
      model.limits.maxDuration === undefined ||
      duration <= model.limits.maxDuration,
  );
  const duration =
    model.videoGeneration?.durations?.[0] ??
    (legacyDurations?.includes(5) ? 5 : legacyDurations?.[0]) ??
    (policy.maxDuration !== undefined
      ? Math.min(5, policy.maxDuration)
      : undefined);
  const resolution =
    policy.resolutions?.[0] ??
    (policy.maxResolution
      ? policy.maxResolution === "480p"
        ? "480p"
        : "720p"
      : undefined);
  const aspectRatio =
    policy.aspectRatios?.[0] ??
    (Object.values(model.limits).some((value) => value !== undefined)
      ? "16:9"
      : undefined);
  return {
    ...input,
    duration: input.duration ?? duration,
    resolution: input.resolution ?? resolution,
    aspectRatio: input.aspectRatio ?? aspectRatio,
  };
}

type VideoGenerateResult = {
  assetId?: string;
  display?: protocol.GeneratedMediaDisplay;
  summary: string;
  title?: string;
  prompt?: string;
  elementId?: string;
  videoUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  placement?: { x: number; y: number; width: number; height: number };
  error?: string;
  jobId?: string;
  jobType?: "video_generation";
};

// ── Run function ───────────────────────────────────────────────────────────

export async function runVideoGenerate(
  rawInput: VideoGenerateInput,
  availableModels: AvailableVideoModel[],
  submitVideoJob?: SubmitVideoJobFn,
): Promise<VideoGenerateResult> {
  let input = rawInput;
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_video] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  if (input.inputImages?.length)
    input = {
      ...input,
      inputImages: mediaReferenceInput(input.inputImages, "image"),
    };
  if (input.inputVideo)
    input = {
      ...input,
      inputVideo: mediaReferenceInput([input.inputVideo], "video")[0],
    };

  const selectedModel = availableModels.find(
    (candidate) => candidate.id === input.model,
  );
  if (!selectedModel) {
    return {
      summary: `Video generation failed: model ${input.model} is not available`,
      error: `Video model is not available: ${input.model}`,
    };
  }

  const policy = videoParameterPolicy(selectedModel);
  input = withModelDefaults(input, selectedModel, policy);
  const capabilityError = validateCapabilities(input, selectedModel, policy);
  if (capabilityError) {
    return {
      summary: `Video generation failed with model ${input.model}: ${capabilityError}`,
      error: capabilityError,
    };
  }

  const enableAudio = policy.audio === false ? undefined : input.enableAudio;

  // Job mode: submit to PGMQ and wait for worker
  if (submitVideoJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitVideoJob({
        ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
        prompt: input.prompt,
        model: input.model,
        ...(input.duration !== undefined ? { duration: input.duration } : {}),
        ...(input.resolution !== undefined
          ? { resolution: input.resolution }
          : {}),
        ...(input.aspectRatio !== undefined
          ? { aspectRatio: input.aspectRatio }
          : {}),
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        ...(input.inputVideo ? { inputVideo: input.inputVideo } : {}),
        ...(enableAudio != null ? { enableAudio } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.placementX !== undefined
          ? { placementX: input.placementX }
          : {}),
        ...(input.placementY !== undefined
          ? { placementY: input.placementY }
          : {}),
        ...(input.placementWidth !== undefined
          ? { placementWidth: input.placementWidth }
          : {}),
        ...(input.placementHeight !== undefined
          ? { placementHeight: input.placementHeight }
          : {}),
      });

      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        const isTimeout = jobResult.error.includes("timed out");
        return {
          summary: isTimeout
            ? "Video is still being generated by the server. It will automatically appear on the canvas once ready — no action needed from the user."
            : `Video generation failed with model ${input.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          error: jobResult.error,
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "video_generation" as const,
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });
      const display = generatedMediaDisplay(jobResult, "video", input.title);

      const result: VideoGenerateResult = {
        jobId: jobResult.jobId,
        ...(jobResult.assetId ? { assetId: jobResult.assetId } : {}),
        ...(display ? { display } : {}),
        summary:
          jobResult.durationSeconds !== undefined
            ? `Generated ${jobResult.durationSeconds}s video via ${input.model}`
            : `Generated video via ${input.model}`,
        title: input.title,
        prompt: input.prompt,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        ...(jobResult.mimeType != null ? { mimeType: jobResult.mimeType } : {}),
        ...(jobResult.videoUrl != null ? { videoUrl: jobResult.videoUrl } : {}),
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
        ...(jobResult.durationSeconds != null
          ? { durationSeconds: jobResult.durationSeconds }
          : {}),
      };
      if (input.placementX != null && input.placementY != null) {
        result.placement = {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 640,
          height: input.placementHeight ?? 360,
        };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Video generation failed with model ${input.model}: ${message}`,
        error: message,
      };
    }
  }

  // BYOK-only：直接生成路径已随内置目录/遗留 env 注册退役——生成一律走
  // submitVideoJob（PGMQ job → worker 按供应商实例异步执行）。
  return {
    summary:
      "Video generation service is not configured on this deployment. Add a provider instance in Settings → Providers first.",
    error: "video_generation_unconfigured",
  };
}

// ── Tool factory ───────────────────────────────────────────────────────────

export function createVideoGenerateToolDefinition(deps?: {
  resolveMediaReferences?: CanvasDocumentAccess["resolveMediaReferences"];
  submitVideoJob?: SubmitVideoJobFn;
  /** 工作区实例的模型清单（BYOK 目录 specifier）；缺省 = 未配置任何实例。 */
  availableModels?: AvailableVideoModel[];
}): ToolDefinition {
  const models = deps?.availableModels ?? [];
  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No video models available";
  const schema = buildVideoGenerateSchema(models);

  return {
    name: "generate_video",
    description: `Generate a video using AI. Available models: ${modelSummary}. Use the selected model's declared parameters and media capabilities in the model field description. Returns the generated video URL.`,
    scope: "design",
    access: "execute",
    zodSchema: schema,
    parameters: z.toJSONSchema(schema),
    execute: async (args, execCtx) => {
      let input = schema.parse(args);
      const requests = [
        ...(input.inputImages ?? []).map((reference) => ({
          reference,
          mediaType: "image" as const,
        })),
        ...(input.inputVideo
          ? [{ reference: input.inputVideo, mediaType: "video" as const }]
          : []),
      ];
      if (deps?.resolveMediaReferences && requests.length) {
        const references = await deps.resolveMediaReferences(execCtx, requests);
        const imageCount = input.inputImages?.length ?? 0;
        input = {
          ...input,
          ...(imageCount
            ? { inputImages: references.slice(0, imageCount) }
            : {}),
          ...(input.inputVideo ? { inputVideo: references[imageCount] } : {}),
        };
      }
      return runVideoGenerate(input, models, deps?.submitVideoJob);
    },
  };
}

function validateCapabilities(
  input: VideoGenerateInput,
  model: AvailableVideoModel,
  policy: VideoParameterPolicy,
): string | undefined {
  if (input.enableAudio === true && policy.audio === false)
    return `${model.displayName} does not support audio generation`;
  const imageToVideo =
    model.videoGeneration?.referenceImages !== undefined
      ? model.videoGeneration.referenceImages > 0
      : model.capabilities.imageToVideo;
  if (input.inputImages?.length && imageToVideo === false) {
    return `${model.displayName} does not support image-to-video input`;
  }
  if (
    policy.referenceImages !== undefined &&
    (input.inputImages?.length ?? 0) > policy.referenceImages
  ) {
    return `${model.displayName} accepts at most ${policy.referenceImages} input image(s)`;
  }
  if (input.inputVideo && model.capabilities.videoToVideo === false) {
    return `${model.displayName} does not support reference-video input`;
  }
  if (
    input.duration !== undefined &&
    policy.maxDuration !== undefined &&
    input.duration > policy.maxDuration
  ) {
    return `${model.displayName} supports at most ${policy.maxDuration} seconds`;
  }
  if (
    input.duration !== undefined &&
    policy.durations &&
    !policy.durations.includes(input.duration)
  ) {
    return `${model.displayName} supports durations: ${policy.durations.join(", ")} seconds`;
  }

  if (
    input.resolution !== undefined &&
    policy.resolutions &&
    !policy.resolutions.includes(input.resolution)
  )
    return `${model.displayName} supports resolutions: ${policy.resolutions.join(", ")}`;
  if (
    input.aspectRatio !== undefined &&
    policy.aspectRatios &&
    !policy.aspectRatios.includes(input.aspectRatio)
  )
    return `${model.displayName} supports aspect ratios: ${policy.aspectRatios.join(", ")}`;

  const requestedResolution =
    input.resolution === "4k" ? "2160p" : input.resolution;
  const resolutionRank: Readonly<Record<string, number>> = {
    "480p": 480,
    "720p": 720,
    "768p": 768,
    "1080p": 1080,
    "2160p": 2160,
  } as const;
  if (
    requestedResolution !== undefined &&
    policy.maxResolution !== undefined &&
    (resolutionRank[requestedResolution] === undefined ||
      (resolutionRank[requestedResolution] ?? 0) >
        (resolutionRank[policy.maxResolution] ?? 0))
  ) {
    return `${model.displayName} supports up to ${policy.maxResolution}`;
  }

  return undefined;
}
