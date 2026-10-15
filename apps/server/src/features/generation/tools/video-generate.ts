import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type { AvailableVideoModel } from "../../../generation/types.js";
import type { ToolDefinition } from "../../../kernel/types.js";
import type { CanvasDocumentAccess } from "../../canvas/document-access.js";
import { generatedMediaDisplay } from "../media-display.js";
import { mediaReferenceInput } from "../media-reference-input.js";
import type { SubmitVideoJobFn } from "../tool-types.js";

export type { SubmitVideoJobFn } from "../tool-types.js";

// ── Dynamic schema builder ─────────────────────────────────────────────────

function buildVideoGenerateSchema(models: AvailableVideoModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds[0];

  const modelDescription = models.length
    ? `Video model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.description}`).join("\n")}`
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
      .int()
      .min(3)
      .max(16)
      .optional()
      .default(5)
      .describe(
        "Video duration in seconds. Valid range depends on model (see model descriptions). Google Veo supports 4/6/8, Replicate models support 3-16.",
      ),
    resolution: z
      .enum(["480p", "720p", "1080p", "4k"])
      .optional()
      .default("720p")
      .describe(
        "Output resolution. 720p recommended for balance of quality and speed. 1080p/4k supported by Google Veo official models (8s duration required).",
      ),
    aspectRatio: z
      .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
      .optional()
      .default("16:9")
      .describe(
        "Video aspect ratio. 16:9 for landscape, 9:16 for portrait/mobile.",
      ),
    inputImages: z
      .array(z.string())
      .max(7)
      .optional()
      .describe(
        "Reference image URLs for image-to-video. First image used as first frame. Only for models with I2V capability.",
      ),
    inputVideo: z
      .string()
      .optional()
      .describe(
        "Source video URL for video-to-video editing. Only for Kling O1.",
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

  const capabilityError = validateCapabilities(input, selectedModel);
  if (capabilityError) {
    return {
      summary: `Video generation failed with model ${input.model}: ${capabilityError}`,
      error: capabilityError,
    };
  }

  const enableAudio = input.enableAudio;

  // Job mode: submit to PGMQ and wait for worker
  if (submitVideoJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitVideoJob({
        ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
        prompt: input.prompt,
        model: input.model,
        duration: input.duration,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
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
    description: `Generate a video using AI. Available models: ${modelSummary}. Supports text-to-video, image-to-video, and video editing. Returns the generated video URL.`,
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
): string | undefined {
  if (input.enableAudio === true && model.capabilities.audio === false)
    return `${model.displayName} does not support audio generation`;
  if (input.inputImages?.length && model.capabilities.imageToVideo === false) {
    return `${model.displayName} does not support image-to-video input`;
  }
  if (
    model.limits.maxInputImages !== undefined &&
    (input.inputImages?.length ?? 0) > model.limits.maxInputImages
  ) {
    return `${model.displayName} accepts at most ${model.limits.maxInputImages} input image(s)`;
  }
  if (input.inputVideo && model.capabilities.videoToVideo === false) {
    return `${model.displayName} does not support reference-video input`;
  }
  if (
    model.limits.maxDuration !== undefined &&
    input.duration > model.limits.maxDuration
  ) {
    return `${model.displayName} supports at most ${model.limits.maxDuration} seconds`;
  }
  if (
    model.limits.allowedDurations &&
    !model.limits.allowedDurations.includes(input.duration)
  ) {
    return `${model.displayName} supports durations: ${model.limits.allowedDurations.join(", ")} seconds`;
  }

  const requestedResolution =
    input.resolution === "4k" ? "2160p" : input.resolution;
  const resolutionRank = {
    "480p": 0,
    "720p": 1,
    "1080p": 2,
    "2160p": 3,
  } as const;
  if (
    model.limits.maxResolution !== undefined &&
    resolutionRank[requestedResolution] >
      resolutionRank[model.limits.maxResolution]
  ) {
    return `${model.displayName} supports up to ${model.limits.maxResolution}`;
  }

  return undefined;
}
