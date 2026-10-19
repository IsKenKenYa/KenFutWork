import { type GenerateContentResponse, GoogleGenAI } from "@google/genai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
  ModelInfo,
} from "../types.js";
import {
  aspectRatioToDimensions,
  createGenerationFetch,
  fetchAsBase64,
  GenerationError,
} from "../utils.js";

// ── Constants ────────────────────────────────────────────────────────────

const PROVIDER_NAME = "google";

const ICON_GOOGLE =
  "https://tjzk.replicate.delivery/models_organizations_avatar/27e1e3fe-f766-4748-83b3-777bc282d8dd/1342004.png";

/**
 * Maps our internal model IDs (with `google-official/` prefix) to the
 * actual Gemini API model name. The prefix avoids collision with
 * Replicate-hosted `google/*` models.
 */
const MODEL_MAP: Record<string, string> = {
  "google-official/gemini-2.5-flash-image": "gemini-2.5-flash-image",
  "google-official/gemini-3.1-flash-image-preview":
    "gemini-3.1-flash-image-preview",
  "google-official/gemini-3-pro-image-preview": "gemini-3-pro-image-preview",
};

const GOOGLE_IMAGE_MODELS: readonly ModelInfo[] = [
  {
    id: "google-official/gemini-3-pro-image-preview",
    displayName: "Nano Banana Pro",
    description:
      "Google Gemini 3 Pro image generation & editing preview. Image input: up to 14 images. Up to 4K resolution. Best quality with advanced reasoning.",
    iconUrl: ICON_GOOGLE,
  },
  {
    id: "google-official/gemini-3.1-flash-image-preview",
    displayName: "Nano Banana 2",
    description:
      "Google Gemini 3.1 image generation & editing preview. Image input: up to 14 images. Faster generation, newest capabilities.",
    iconUrl: ICON_GOOGLE,
  },
  {
    id: "google-official/gemini-2.5-flash-image",
    displayName: "Nano Banana",
    description:
      "Google Gemini native image generation & editing via direct API. Image input: up to 14 images. Stable. Best balance of speed and quality.",
    iconUrl: ICON_GOOGLE,
  },
];

/** Semantic quality → Gemini imageSize param. */
const QUALITY_TO_IMAGE_SIZE: Record<string, string> = {
  standard: "1K",
  hd: "2K",
  ultra: "4K",
};

/** Gemini finish reasons that indicate content policy / safety blocks. */
const SAFETY_FINISH_REASONS = new Set([
  "SAFETY",
  "IMAGE_SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

// ── Provider ─────────────────────────────────────────────────────────────

export class GoogleImageProvider implements ImageProvider {
  readonly name = PROVIDER_NAME;
  readonly models = GOOGLE_IMAGE_MODELS;

  private client: GoogleGenAI;

  constructor(
    apiKey: string,
    headers?: Record<string, string>,
    baseUrl?: string,
  ) {
    this.client = new GoogleGenAI({
      apiKey,
      // 自定义头（§4.8）：x-goog-api-key 等保留头由 SDK 按 apiKey 生成，不受其影响
      httpOptions: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(headers ? { headers } : {}),
        retryOptions: { attempts: 1 },
        fetch: createGenerationFetch(PROVIDER_NAME, [apiKey]),
      },
    });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const apiModel = MODEL_MAP[params.model] ?? params.model;
    if (params.outputFormat != null) {
      throw new GenerationError(
        PROVIDER_NAME,
        "unsupported",
        "当前 Google 图片接口不能指定输出格式，请清空格式选项。",
      );
    }
    if (params.width != null || params.height != null) {
      throw new GenerationError(
        PROVIDER_NAME,
        "unsupported",
        "当前 Google 图片接口不能指定像素宽高，请改用比例与质量。",
      );
    }
    if (apiModel === "gemini-2.5-flash-image" && params.quality != null) {
      throw new GenerationError(
        PROVIDER_NAME,
        "unsupported",
        "Gemini 2.5 图片模型不能指定质量，请清空质量选项。",
      );
    }

    const aspectRatio = params.aspectRatio ?? "1:1";
    const imageSize =
      QUALITY_TO_IMAGE_SIZE[params.quality ?? "hd"] ?? params.quality ?? "2K";

    // Build content parts: text prompt + optional input images.
    const parts: Array<
      { text: string } | { inlineData: { mimeType: string; data: string } }
    > = [{ text: params.prompt }];

    if (params.inputImages?.length) {
      const fetched = await Promise.all(
        params.inputImages.map((url) => fetchAsBase64(PROVIDER_NAME, url)),
      );
      for (const img of fetched) {
        parts.push({
          inlineData: { mimeType: img.mimeType, data: img.data },
        });
      }
    }

    let response: GenerateContentResponse;
    try {
      response = await this.client.models.generateContent({
        model: apiModel,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: {
            aspectRatio,
            // Gemini 2.5 Flash Image 仅支持默认尺寸；3 系及实例自定义模型沿用尺寸选项。
            ...(apiModel === "gemini-2.5-flash-image" ? {} : { imageSize }),
          },
        },
      });
    } catch (err) {
      if (err instanceof GenerationError) throw err;
      throw new GenerationError(
        PROVIDER_NAME,
        "api_error",
        "Google 图片请求失败，请检查供应商设置。",
      );
    }

    // Check for safety blocks.
    const candidate = response.candidates?.[0];
    if (
      candidate?.finishReason &&
      SAFETY_FINISH_REASONS.has(candidate.finishReason)
    ) {
      throw new GenerationError(
        PROVIDER_NAME,
        "safety_filter",
        `Image generation blocked by safety filter (reason: ${candidate.finishReason})`,
      );
    }

    if (response.promptFeedback?.blockReason) {
      throw new GenerationError(
        PROVIDER_NAME,
        "safety_filter",
        `Prompt blocked by safety filter (reason: ${response.promptFeedback.blockReason})`,
      );
    }

    // Extract base64 image from response parts.
    const imagePart = candidate?.content?.parts?.find(
      (p) => p.inlineData?.data,
    );
    const inlineData = imagePart?.inlineData;

    if (!inlineData?.data) {
      throw new GenerationError(
        PROVIDER_NAME,
        "no_output",
        "Gemini returned no image data in response",
      );
    }

    const mimeType = inlineData.mimeType ?? "image/png";
    const dataUri = `data:${mimeType};base64,${inlineData.data}`;
    const { width, height } = aspectRatioToDimensions(aspectRatio);

    return { url: dataUri, mimeType, width, height };
  }
}
