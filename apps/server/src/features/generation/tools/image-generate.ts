import type { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";
import type {
  AvailableModel,
  ImageQuality,
  OutputFormat,
} from "../../../generation/types.js";
import { findOwnedToolInterruption } from "../../../kernel/owned-tool-interruption.js";
import type { ToolDefinition } from "../../../kernel/types.js";
import type { CanvasDocumentAccess } from "../../canvas/document-access.js";
import { generatedMediaDisplay } from "../media-display.js";
import { mediaReferenceInput } from "../media-reference-input.js";
import type { PersistImageFn, SubmitImageJobFn } from "../tool-types.js";

export type { PersistImageFn, SubmitImageJobFn } from "../tool-types.js";

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
  canvas_id?: string | undefined;
  title: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  quality?: ImageQuality;
  outputFormat?: OutputFormat | undefined;
  inputImages?: string[] | undefined;
  placementX?: number | undefined;
  placementY?: number | undefined;
  placementWidth?: number;
  placementHeight?: number;
};

type ImageGenerateResult = {
  assetId?: string;
  display?: protocol.GeneratedMediaDisplay;
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

  if (input.inputImages?.length)
    input = {
      ...input,
      inputImages: mediaReferenceInput(
        input.inputImages,
        "image",
        attachmentMap,
      ),
    };

  // Job mode: submit to PGMQ and wait for worker to complete
  if (submitImageJob) {
    try {
      lap("job_submit", { model: input.model });
      const jobResult = await submitImageJob({
        ...(input.canvas_id ? { canvasId: input.canvas_id } : {}),
        prompt: input.prompt,
        title: input.title,
        model: input.model,
        aspectRatio: input.aspectRatio ?? "1:1",
        ...(input.inputImages ? { inputImages: input.inputImages } : {}),
        quality: input.quality ?? "hd",
        ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
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
            ? `Image is still being generated by the server. It will automatically appear on the canvas once ready — no action needed from the user.`
            : `Image generation failed: ${jobResult.error}`,
          error: jobResult.error,
          // Expose jobId so frontend can poll for late-arriving results
          // (worker may still succeed after agent poll timeout)
          jobId: jobResult.jobId,
          jobType: "image_generation" as const,
        };
      }
      lap("job_complete", { jobId: jobResult.jobId });
      const display = generatedMediaDisplay(jobResult, "image", input.title);

      const result: ImageGenerateResult = {
        jobId: jobResult.jobId,
        ...(jobResult.assetId ? { assetId: jobResult.assetId } : {}),
        ...(display ? { display } : {}),
        summary:
          jobResult.width !== undefined && jobResult.height !== undefined
            ? `Generated image (${jobResult.width}x${jobResult.height}) via ${input.model}`
            : `Generated image via ${input.model}`,
        title: input.title,
        ...(jobResult.elementId != null
          ? { elementId: jobResult.elementId }
          : {}),
        ...(jobResult.imageUrl != null ? { imageUrl: jobResult.imageUrl } : {}),
        ...(jobResult.mimeType != null ? { mimeType: jobResult.mimeType } : {}),
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
      if (findOwnedToolInterruption(error)) throw error;
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        summary: `Image generation failed: ${message}`,
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

export function createImageGenerateToolDefinition(deps?: {
  resolveMediaReferences?: CanvasDocumentAccess["resolveMediaReferences"];
  persistImage?: PersistImageFn;
  submitImageJob?: SubmitImageJobFn;
  /** 工作区实例的模型清单（BYOK 目录 specifier）；缺省 = 未配置任何实例。 */
  availableModels?: AvailableModel[];
}): ToolDefinition {
  const models = deps?.availableModels ?? [];
  const modelSummary = models.length
    ? models.map((m) => `${m.displayName} (${m.id})`).join(", ")
    : "No models available";
  const schema = buildImageGenerateSchema(models);

  return {
    name: "generate_image",
    description: `Generate an image using AI. Available models: ${modelSummary}. Returns the generated image URL.`,
    scope: "design",
    access: "execute",
    zodSchema: schema,
    parameters: z.toJSONSchema(schema),
    execute: async (args, execCtx) => {
      const input = schema.parse(args);
      const inputImages =
        deps?.resolveMediaReferences && input.inputImages?.length
          ? await deps.resolveMediaReferences(
              execCtx,
              input.inputImages.map((reference) => ({
                reference,
                mediaType: "image",
              })),
            )
          : input.inputImages;
      return runImageGenerate(
        { ...input, ...(inputImages ? { inputImages } : {}) },
        deps?.persistImage,
        deps?.submitImageJob,
        execCtx.userAttachmentMap,
      );
    },
  };
}
