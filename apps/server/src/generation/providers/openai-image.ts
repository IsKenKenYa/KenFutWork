import OpenAI from "openai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
} from "../types.js";
import {
  aspectRatioToDimensions,
  GenerationError,
  readGeneratedImage,
} from "../utils.js";

function imageOptions(params: ImageGenerateParams) {
  const dimensions = aspectRatioToDimensions(params.aspectRatio ?? "1:1");
  // GPT Image 的标准尺寸不能用通用画布比例生成任意像素值。
  const gptImage =
    params.model.startsWith("gpt-image-") ||
    params.model === "chatgpt-image-latest";
  const { width, height } = gptImage
    ? dimensions.width === dimensions.height
      ? { width: 1024, height: 1024 }
      : dimensions.width > dimensions.height
        ? { width: 1536, height: 1024 }
        : { width: 1024, height: 1536 }
    : dimensions;
  const outputFormat: "png" | "jpeg" | "webp" | undefined = !gptImage
    ? undefined
    : params.outputFormat === "jpg"
      ? "jpeg"
      : params.outputFormat;
  const quality = params.quality
    ? { standard: "low", hd: "medium", ultra: "high" }[params.quality]
    : undefined;
  return {
    width,
    height,
    size: `${width}x${height}`,
    mimeType:
      outputFormat === "jpeg"
        ? "image/jpeg"
        : outputFormat === "webp"
          ? "image/webp"
          : "image/png",
    ...(gptImage && quality
      ? { quality: quality as "low" | "medium" | "high" }
      : {}),
    ...(outputFormat ? { output_format: outputFormat } : {}),
  };
}

/**
 * 参考图 → multipart 文件体：URL 先下载、data URL 就地解码、裸 base64 兜底。
 * 编辑路径（/images/edits）只接受文件上传，不接受 URL 字符串。
 */
async function toUploadFile(source: string): Promise<File> {
  let bytes: Buffer;
  let mime: string;
  if (source.startsWith("data:")) {
    const commaIndex = source.indexOf(",");
    const meta = source.slice(5, commaIndex);
    mime = meta.split(";")[0] || "image/png";
    const data = source.slice(commaIndex + 1);
    bytes = meta.includes(";base64")
      ? Buffer.from(data, "base64")
      : Buffer.from(decodeURIComponent(data), "utf8");
  } else if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new GenerationError(
        "openai",
        "api_error",
        `参考图下载失败：HTTP ${response.status}`,
      );
    }
    bytes = Buffer.from(await response.bytes());
    mime = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  } else {
    bytes = Buffer.from(source, "base64");
    mime = "image/png";
  }
  return new File([new Uint8Array(bytes)], "input.png", { type: mime });
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  // TODO: 补充 models 列表后前端 image-models API 才会展示 OpenAI 模型供用户选择
  readonly models = [] as const;
  private client: OpenAI;
  private apiKey: string;
  private baseURL: string | undefined;
  private headers: Record<string, string> | undefined;

  constructor(
    apiKey: string,
    baseURL?: string,
    headers?: Record<string, string>,
  ) {
    this.client = new OpenAI({
      apiKey,
      // 适配器只执行一次请求；可调重试由共享Job引擎统一负责。
      maxRetries: 0,
      ...(baseURL ? { baseURL } : {}),
      // 自定义头（§4.8）：authorization 等保留头由 SDK 按 apiKey 生成，不受其影响
      ...(headers ? { defaultHeaders: headers } : {}),
    });
    this.apiKey = apiKey;
    this.baseURL = baseURL?.replace(/\/+$/, "");
    this.headers = headers;
  }

  /**
   * 编辑路径（S5 缝）：/images/edits。刻意不走 SDK 的 images.edit——其内部对
   * uploadable 的处理不可控（实测会把 blob 交给全局 fetch 去取），手写
   * multipart 与 volces-image 同风格：自定义头在前、凭证随后、形状可抓包锁定。
   */
  private async generateEdit(
    params: ImageGenerateParams,
    options: ReturnType<typeof imageOptions>,
  ): Promise<GeneratedImage> {
    const baseURL = this.baseURL ?? "https://api.openai.com/v1";
    const form = new FormData();
    form.append("model", params.model);
    form.append("prompt", params.prompt);
    form.append("n", "1");
    form.append("size", options.size);
    if (options.quality) form.append("quality", options.quality);
    if (options.output_format)
      form.append("output_format", options.output_format);
    const imageField =
      (params.inputImages?.length ?? 0) > 1 ? "image[]" : "image";
    for (const source of params.inputImages ?? []) {
      form.append(imageField, await toUploadFile(source));
    }

    const response = await fetch(`${baseURL}/images/edits`, {
      method: "POST",
      headers: {
        // 自定义头（§4.8）在前，凭证与内容类型随后——保留头永远由适配器说了算
        ...this.headers,
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new GenerationError(
        "openai",
        "api_error",
        `OpenAI edits error ${response.status}: ${errorBody?.error?.message ?? "Unknown error"}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ url?: string; b64_json?: string }>;
    };
    return readGeneratedImage("openai", data, options);
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const options = imageOptions(params);

    try {
      // 带参考图 → 编辑路径；否则生成路径不变。
      if (params.inputImages?.length) {
        return await this.generateEdit(params, options);
      }

      const response = await this.client.images.generate({
        model: params.model,
        prompt: params.prompt,
        size: options.size as "1024x1024",
        n: 1,
        ...(options.quality ? { quality: options.quality } : {}),
        ...(options.output_format
          ? { output_format: options.output_format }
          : {}),
      });
      return readGeneratedImage("openai", response, options);
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw new GenerationError(
        "openai",
        "api_error",
        error instanceof Error ? error.message : "Unknown OpenAI error",
      );
    }
  }
}
