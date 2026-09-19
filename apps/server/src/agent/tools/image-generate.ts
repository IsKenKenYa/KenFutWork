import { tool } from "langchain";
import { z } from "zod";
import type {
  AvailableModel,
  ImageQuality,
  OutputFormat,
} from "../../generation/types.js";

/**
 * Build the zod schema dynamically from the models available in the registry.
 * Falls back to a plain string field when no providers are registered.
 */
function buildImageGenerateSchema(models: AvailableModel[]) {
  const modelIds = models.map((m) => m.id);
  const defaultModel = modelIds[0];

  const modelDescription = models.length
    ? `Model to use. Available:\n${models.map((m) => `- ${m.id}: ${m.displayName} — ${m.description}`).join("\n")}`
    : "Model identifier (no providers currently registered)";

  // z.enum needs [string, ...string[]], but we may have 0 models at test time.
  const modelField =
    modelIds.length >= 1
      ? z
          .enum(modelIds as [string, ...string[]])
          .default(defaultModel as string)
          .describe(modelDescription)
      : z
          .string()
          .describe(
            "Model identifier（当前未配置任何供应商实例——请先在设置 → 供应商添加）",
          );

  return z.object({
    title: z
      .string()
      .min(1)
      .describe(
        "Short descriptive title for the generated image, used as metadata so the image content is understood without re-analysis",
      ),
    prompt: z.string().min(1).describe("Detailed image generation prompt"),
    model: modelField,
    aspectRatio: z
      .string()
      .optional()
      .default("1:1")
      .describe(
        "Aspect ratio (e.g. 1:1, 16:9, 9:16, 4:3, 3:4, 4:5, 5:4, 2:3, 3:2). Provider auto-normalizes unsupported ratios to nearest match.",
      ),
    quality: z
      .enum(["standard", "hd", "ultra"])
      .optional()
      .default("hd")
      .describe(
        "Image quality/resolution level. standard: ~1K fast preview, hd: ~2K production quality (default), ultra: ~4K print quality (not all models support this, will use max available).",
      ),
    outputFormat: z
      .enum(["png", "jpg", "webp"])
      .optional()
      .describe(
        "Output image format. PNG for transparency, JPG for photos, WebP for web.",
      ),
    inputImages: z
      .array(z.string())
      .optional()
      .describe(
        "Reference image URLs for editing/transformation. Google models accept up to 14, Flux models accept 1. Imagen 4 and Recraft V3 are text-only.",
      ),
    placementX: z
      .number()
      .optional()
      .describe(
        "Left edge x coordinate on canvas. Use inspect_canvas to determine position.",
      ),
    placementY: z
      .number()
      .optional()
      .describe(
        "Top edge y coordinate on canvas. Use inspect_canvas to determine position.",
      ),
    placementWidth: z
      .number()
      .optional()
      .default(512)
      .describe("Display width on canvas"),
    placementHeight: z
      .number()
      .optional()
      .default(512)
      .describe("Display height on canvas"),
  });
}

type ImageGenerateInput = {
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: ImageQuality;
  outputFormat?: OutputFormat;
  inputImages?: string[];
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
};

type ImageGenerateResult = {
  summary: string;
  title?: string;
  elementId?: string;
  imageUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
  jobId?: string;
  jobType?: "image_generation";
  placement?: { x: number; y: number; width: number; height: number };
};

/**
 * Optional function to persist a generated image to OSS.
 * Accepts the ephemeral URL and returns a persistent signed URL.
 */
export type PersistImageFn = (
  sourceUrl: string,
  mimeType: string,
  prompt: string,
) => Promise<string>;

/**
 * Submit an image generation job and wait for it to complete.
 * Returns the final result: signed_url on success, error on failure.
 */
export type SubmitImageJobFn = (input: {
  prompt: string;
  title: string;
  model: string;
  aspectRatio: string;
  inputImages?: string[];
  quality?: string;
  /** 画布落点（可选）：运行时的作业回调据此显式指定插入位置。 */
  placementX?: number;
  placementY?: number;
  placementWidth?: number;
  placementHeight?: number;
}) => Promise<{
  jobId: string;
  elementId?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  error?: string;
}>;

export async function runImageGenerate(
  input: ImageGenerateInput,
  _persistImage?: PersistImageFn,
  submitImageJob?: SubmitImageJobFn,
  attachmentMap?: Record<string, string>,
): Promise<ImageGenerateResult> {
  const t0 = Date.now();
  const lap = (label: string, extra?: Record<string, unknown>) => {
    console.log(
      `[generate_image] ${label} +${Date.now() - t0}ms`,
      extra ? JSON.stringify(extra) : "",
    );
  };

  // Resolve assetId references in inputImages to base64 data URIs
  if (input.inputImages?.length && attachmentMap) {
    input = {
      ...input,
      inputImages: input.inputImages.map((ref) => attachmentMap[ref] ?? ref),
    };
  }

  // Filter out invalid image references — only keep valid URLs.
  // Agent may pass canvas element IDs or unresolved assetIds that aren't
  // in the attachmentMap. These would cause Replicate 422 errors.
  if (input.inputImages?.length) {
    const validImages = input.inputImages.filter(
      (img) =>
        img.startsWith("http://") ||
        img.startsWith("https://") ||
        img.startsWith("data:"),
    );
    if (validImages.length !== input.inputImages.length) {
      lap("filtered_invalid_refs", {
        before: input.inputImages.length,
        after: validImages.length,
        dropped: input.inputImages.filter(
          (img) =>
            !img.startsWith("http://") &&
            !img.startsWith("https://") &&
            !img.startsWith("data:"),
        ),
      });
    }
    input =
      validImages.length > 0
        ? { ...input, inputImages: validImages }
        : { ...input, inputImages: [] };
  }

  // Job mode: submit to PGMQ and wait for worker to complete
  if (submitImageJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitImageJob({
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        aspectRatio: input.aspectRatio ?? "1:1",
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      });

      if (jobResult.error) {
        lap("job_failed", { error: jobResult.error });
        const isTimeout = jobResult.error.includes("timed out");
        return {
          summary: isTimeout
            ? `Image is still being generated by the server. It will automatically appear on the canvas once ready — no action needed from the user.`
            : `Image generation failed with model ${input.model}: ${jobResult.error}. Consider trying a different model or simplifying the prompt.`,
          error: jobResult.error,
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "image_generation" as const,
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });

      const result: ImageGenerateResult = {
        summary: `Generated image (${jobResult.width ?? 0}x${jobResult.height ?? 0}) via ${input.model}`,
        title: input.title,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        imageUrl: jobResult.imageUrl ?? "",
        mimeType: jobResult.mimeType ?? "image/png",
        ...(jobResult.width != null ? { width: jobResult.width } : {}),
        ...(jobResult.height != null ? { height: jobResult.height } : {}),
      };
      if (input.placementX != null && input.placementY != null) {
        result.placement = {
          x: input.placementX,
          y: input.placementY,
          width: input.placementWidth ?? 512,
          height: input.placementHeight ?? 512,
        };
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Image generation failed with model ${input.model}: ${message}. Consider trying a different model or simplifying the prompt.`,
        error: message,
      };
    }
  }

  // BYOK-only：直接生成路径已随内置目录/遗留 env 注册退役——生成一律走
  // submitImageJob（PGMQ job → worker 按供应商实例执行）。
  return {
    summary:
      "Image generation service is not configured on this deployment. Add a provider instance in Settings → Providers first.",
    error: "image_generation_unconfigured",
  };
}

export function createImageGenerateTool(deps?: {
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  /** 工作区实例的模型清单（BYOK 目录 specifier）；缺省 = 未配置任何实例。 */
  availableModels?: AvailableModel[];
}) {
  const models = deps?.availableModels ?? [];

  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";

  return tool(
    async (input: ImageGenerateInput, config) => {
      const configurable = (
        config as { configurable?: Record<string, unknown> }
      )?.configurable;
      const attachmentMap = configurable?.user_attachment_map as
        | Record<string, string>
        | undefined;
      return await runImageGenerate(
        input,
        deps?.persistImage,
        deps?.submitImageJob,
        attachmentMap,
      );
    },
    {
      name: "generate_image",
      description: `Generate an image using AI. Available models: ${modelSummary}. Returns the generated image URL.`,
      schema: buildImageGenerateSchema(models),
    },
  );
}
