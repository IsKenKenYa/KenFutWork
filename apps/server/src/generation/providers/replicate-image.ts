import {
  type ReplicatePrediction,
  ReplicatePredictionsClient,
} from "../../providers/replicate/predictions.js";
import type {
  GeneratedImage,
  ImageAsyncPollResult,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import { aspectRatioToDimensions, GenerationError } from "../utils.js";

/**
 * Image input parameter mapping per model.
 *
 * Replicate models use different parameter names for image input:
 * - `input_image`  (single URL string)  → Flux Kontext family
 * - `input_images` (array of URL strings) → OpenAI GPT Image
 * - `image_input`  (array of URL strings) → Google Nano Banana, ByteDance Seedream (default)
 */
const SINGLE_IMAGE_INPUT_MODELS = new Set([
  "black-forest-labs/flux-kontext-pro",
  "black-forest-labs/flux-kontext-max",
  "black-forest-labs/flux-1.1-pro",
  "black-forest-labs/flux-pro",
]);

const INPUT_IMAGES_MODELS = new Set([
  "openai/gpt-image-1.5",
  "openai/gpt-image-1",
]);

/**
 * Models that don't support any image input.
 */
const TEXT_ONLY_MODELS = new Set([
  "google/imagen-4",
  "google/imagen-3",
  "recraft-ai/recraft-v3",
]);

/**
 * Recraft uses `size` (e.g. "1024x1024") instead of `aspect_ratio`.
 */
const RECRAFT_MODELS = new Set(["recraft-ai/recraft-v3"]);

const ICON_GOOGLE =
  "https://tjzk.replicate.delivery/models_organizations_avatar/27e1e3fe-f766-4748-83b3-777bc282d8dd/1342004.png";
const ICON_OPENAI = "https://github.com/openai.png";
const ICON_BFL =
  "https://tjzk.replicate.delivery/models_organizations_avatar/01ed70be-0d47-4a4a-85fb-32c02cdd4ab5/bfl.png";
const ICON_BYTEDANCE = "https://github.com/bytedance.png";
const ICON_RECRAFT = "https://github.com/recraft-ai.png";

const REPLICATE_IMAGE_MODELS: readonly ModelInfo[] = [
  // Google
  {
    id: "google/nano-banana-pro",
    displayName: "Nano Banana Pro",
    description:
      "Google's SOTA image generation & editing model. Image input: up to 14 images. Up to 4K resolution. Best for multi-reference editing.",
    iconUrl: ICON_GOOGLE,
  },
  {
    id: "google/nano-banana-2",
    displayName: "Nano Banana 2",
    description:
      "Fast image generation with conversational editing and character consistency. Image input: up to 14 images. Good for multi-image fusion.",
    iconUrl: ICON_GOOGLE,
  },
  {
    id: "google/nano-banana",
    displayName: "Nano Banana",
    description:
      "Google's image editing model in Gemini 2.5. Image input: up to 14 images. Best for editing & transformation tasks.",
    iconUrl: ICON_GOOGLE,
  },
  {
    id: "google/imagen-4",
    displayName: "Imagen 4",
    description:
      "Google's Imagen 4 flagship text-to-image model. Image input: NONE (text-only). Best pure text-to-image quality.",
    iconUrl: ICON_GOOGLE,
  },
  // OpenAI
  {
    id: "openai/gpt-image-1.5",
    displayName: "GPT Image 1.5",
    description:
      "OpenAI's latest image model with better instruction following. Image input: multiple images. Supports background transparency.",
    iconUrl: ICON_OPENAI,
  },
  // Black Forest Labs
  {
    id: "black-forest-labs/flux-kontext-max",
    displayName: "Flux Kontext Max",
    description:
      "Premium text-based image editing with maximum performance and improved typography. Image input: 1 image only. Best for single-image editing.",
    iconUrl: ICON_BFL,
  },
  {
    id: "black-forest-labs/flux-kontext-pro",
    displayName: "Flux Kontext Pro",
    description:
      "SOTA text-based image editing with excellent prompt following and consistent results. Image input: 1 image only. Best for single-image editing.",
    iconUrl: ICON_BFL,
  },
  // ByteDance
  {
    id: "bytedance/seedream-5-lite",
    displayName: "Seedream 5.0 Lite",
    description:
      "Image generation with built-in reasoning and example-based editing. Image input: multiple images. Up to 3K resolution.",
    iconUrl: ICON_BYTEDANCE,
  },
  {
    id: "bytedance/seedream-4.5",
    displayName: "Seedream 4.5",
    description:
      "Upgraded ByteDance model with stronger spatial understanding. Image input: multiple images. Up to 4K resolution.",
    iconUrl: ICON_BYTEDANCE,
  },
  {
    id: "bytedance/seedream-4",
    displayName: "Seedream 4",
    description:
      "Unified text-to-image generation and precise editing. Image input: multiple images. Up to 4K resolution.",
    iconUrl: ICON_BYTEDANCE,
  },
  // Recraft
  {
    id: "recraft-ai/recraft-v3",
    displayName: "Recraft V3",
    description:
      "SOTA text-to-image with long text rendering and wide style variety. Image input: NONE (text-only). #1 by Artificial Analysis benchmark.",
    iconUrl: ICON_RECRAFT,
  },
];

// ── Quality → model-specific resolution translation ──────────────────────

type QualityMap = Record<
  string,
  Record<string, { param: string; value: string }>
>;

/**
 * Maps known semantic quality values to a model's native parameter.
 */
const QUALITY_MAP: QualityMap = {
  // Google Nano Banana Pro / 2: uses `resolution`
  "google/nano-banana-pro": {
    standard: { param: "resolution", value: "1K" },
    hd: { param: "resolution", value: "2K" },
    ultra: { param: "resolution", value: "4K" },
  },
  "google/nano-banana-2": {
    standard: { param: "resolution", value: "1K" },
    hd: { param: "resolution", value: "2K" },
    ultra: { param: "resolution", value: "4K" },
  },
  // Google Imagen 4: uses `image_size`
  "google/imagen-4": {
    standard: { param: "image_size", value: "1K" },
    hd: { param: "image_size", value: "2K" },
  },
  // ByteDance Seedream 5 Lite: uses `size`, max 3K
  "bytedance/seedream-5-lite": {
    standard: { param: "size", value: "2K" },
    hd: { param: "size", value: "2K" },
    ultra: { param: "size", value: "3K" },
  },
  // ByteDance Seedream 4.5: uses `size`, max 4K
  "bytedance/seedream-4.5": {
    standard: { param: "size", value: "2K" },
    hd: { param: "size", value: "2K" },
    ultra: { param: "size", value: "4K" },
  },
  // ByteDance Seedream 4: uses `size`, max 4K
  "bytedance/seedream-4": {
    standard: { param: "size", value: "1K" },
    hd: { param: "size", value: "2K" },
    ultra: { param: "size", value: "4K" },
  },
};

/** GPT Image 1.5 quality mapping (native `quality` param) */
const GPT_IMAGE_QUALITY: Record<string, string> = {
  standard: "medium",
  hd: "high",
  ultra: "high",
};

function applyQuality(
  input: Record<string, unknown>,
  model: string,
  quality: string | undefined,
): void {
  if (!quality) return;

  if (INPUT_IMAGES_MODELS.has(model)) {
    const nativeQuality = GPT_IMAGE_QUALITY[quality] ?? quality;
    if (!["low", "medium", "high", "auto"].includes(nativeQuality)) {
      throw new GenerationError(
        "replicate",
        "unsupported",
        `模型${model}不支持质量${quality}。`,
      );
    }
    input.quality = nativeQuality;
    return;
  }
  const modelMap = QUALITY_MAP[model];
  if (modelMap) {
    const entry =
      modelMap[quality] ??
      Object.values(modelMap).find((item) => item.value === quality);
    if (!entry)
      throw new GenerationError(
        "replicate",
        "unsupported",
        `模型${model}不支持质量${quality}。`,
      );
    input[entry.param] = entry.value;
    return;
  }
  if (REPLICATE_IMAGE_MODELS.some((known) => known.id === model)) {
    throw new GenerationError(
      "replicate",
      "unsupported",
      `模型${model}不支持此质量参数。`,
    );
  }
  input.quality = quality;
}

// ── Aspect ratio normalization ────────────────────────────────────────────

/**
 * Models with restricted aspect_ratio support.
 * Models NOT listed here accept all ratios the tool exposes.
 */
const MODEL_ASPECT_RATIOS: Record<string, string[]> = {
  "openai/gpt-image-1.5": ["1:1", "3:2", "2:3"],
  "openai/gpt-image-1": ["1:1", "3:2", "2:3"],
};

function validateAspectRatio(model: string, ratio: string): string {
  const supported = MODEL_ASPECT_RATIOS[model];
  if (supported && !supported.includes(ratio)) {
    throw new GenerationError(
      "replicate",
      "unsupported",
      `模型${model}不支持比例${ratio}。`,
    );
  }
  return ratio;
}

// ── Output format translation ────────────────────────────────────────────

/** Models that don't accept output_format */
const NO_OUTPUT_FORMAT_MODELS = new Set([
  "bytedance/seedream-4.5",
  "bytedance/seedream-4",
  "recraft-ai/recraft-v3",
]);

function applyOutputFormat(
  input: Record<string, unknown>,
  model: string,
  format: string | undefined,
): void {
  if (!format) return;
  if (NO_OUTPUT_FORMAT_MODELS.has(model)) {
    throw new GenerationError(
      "replicate",
      "unsupported",
      `模型${model}不支持指定输出格式。`,
    );
  }
  input.output_format = format;
}

// ── Provider implementation ──────────────────────────────────────────────

export class ReplicateImageProvider implements ImageProvider {
  readonly name = "replicate";
  readonly models = REPLICATE_IMAGE_MODELS;
  private readonly predictions: ReplicatePredictionsClient;

  constructor(
    apiToken: string,
    headers?: Record<string, string>,
    baseUrl?: string,
  ) {
    this.predictions = new ReplicatePredictionsClient(
      apiToken,
      headers,
      baseUrl,
    );
  }

  prepareInputs(params: ImageGenerateParams): Promise<ImageGenerateParams> {
    this.buildInput(params);
    return this.predictions.prepareInputs(params);
  }

  async startAsync(
    params: ImageGenerateParams,
  ): Promise<{ providerJobId: string }> {
    params = await this.prepareInputs(params);
    const { input } = this.buildInput(params);
    const prediction = await this.predictions.create(params.model, input, {
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!prediction.id) {
      throw new GenerationError(
        "replicate",
        "malformed_response",
        "Replicate submit response missing prediction id",
      );
    }
    return { providerJobId: prediction.id };
  }

  async pollAsync(providerJobId: string): Promise<ImageAsyncPollResult> {
    const prediction = await this.predictions.get(providerJobId);
    if (prediction.status === "succeeded") {
      const images = this.readImages(prediction);
      return images.length
        ? { state: "succeeded", images }
        : {
            state: "failed",
            errorMessage: "Replicate returned no image output URL",
          };
    }
    if (prediction.status === "failed" || prediction.status === "canceled") {
      return {
        state: "failed",
        errorMessage: prediction.error ?? prediction.status,
      };
    }
    return { state: "in_progress" };
  }

  cancelAsync(providerJobId: string): Promise<void> {
    return this.predictions.cancel(providerJobId);
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    params = await this.prepareInputs(params);
    const { input, width, height } = this.buildInput(params);
    const prediction = await this.predictions.create(params.model, input, {
      wait: true,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const image = this.readImages({ ...prediction, input })[0];
    if (!image) {
      throw new GenerationError(
        "replicate",
        "no_output",
        "Replicate returned no output URL",
      );
    }
    return { ...image, width, height };
  }

  private readImages(prediction: ReplicatePrediction): GeneratedImage[] {
    const input = prediction.input ?? {};
    const dimensions = aspectRatioToDimensions(
      typeof input.aspect_ratio === "string" ? input.aspect_ratio : "1:1",
    );
    const width =
      typeof input.width === "number" ? input.width : dimensions.width;
    const height =
      typeof input.height === "number" ? input.height : dimensions.height;
    const outputs = Array.isArray(prediction.output)
      ? prediction.output
      : prediction.output
        ? [prediction.output]
        : [];
    return outputs
      .filter((url) => typeof url === "string" && url.length > 0)
      .map((url) => ({
        url,
        mimeType:
          input.output_format === "jpg"
            ? "image/jpeg"
            : input.output_format === "webp"
              ? "image/webp"
              : "image/png",
        width,
        height,
      }));
  }

  private buildInput(params: ImageGenerateParams): {
    input: Record<string, unknown>;
    width: number;
    height: number;
  } {
    const model = params.model.split(":")[0] ?? params.model;
    const rawRatio = params.aspectRatio ?? "1:1";
    const aspectRatio = validateAspectRatio(model, rawRatio);
    const defaults = aspectRatioToDimensions(aspectRatio);
    const width = params.width ?? defaults.width;
    const height = params.height ?? defaults.height;

    const input: Record<string, unknown> = {
      prompt: params.prompt,
    };

    // Aspect ratio / size — Recraft uses pixel `size`, others use `aspect_ratio`
    if (RECRAFT_MODELS.has(model)) {
      input.size = `${width}x${height}`;
    } else {
      input.aspect_ratio = aspectRatio;
      if (params.width !== undefined) input.width = params.width;
      if (params.height !== undefined) input.height = params.height;
    }

    // Image input — parameter name varies by model
    if (params.inputImages?.length) {
      if (
        TEXT_ONLY_MODELS.has(model) ||
        (SINGLE_IMAGE_INPUT_MODELS.has(model) && params.inputImages.length > 1)
      ) {
        throw new GenerationError(
          "replicate",
          "unsupported",
          `模型${model}不支持这些参考图。`,
        );
      }
      if (SINGLE_IMAGE_INPUT_MODELS.has(model)) {
        input.input_image = params.inputImages[0];
      } else if (INPUT_IMAGES_MODELS.has(model)) {
        input.input_images = params.inputImages;
      } else {
        input.image_input = params.inputImages;
      }
    }

    // Semantic params → model-specific translation
    applyQuality(input, model, params.quality);
    applyOutputFormat(input, model, params.outputFormat);

    return {
      input,
      width,
      height,
    };
  }
}
