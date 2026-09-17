import OpenAI, { toFile, type Uploadable } from "openai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
} from "../types.js";
import { aspectRatioToDimensions, GenerationError } from "../utils.js";

/**
 * 参考图 → multipart 上传体：URL 先下载、data URL 就地解码、裸 base64 兜底。
 * 编辑路径（/images/edits）只接受文件上传，不接受 URL 字符串。
 */
async function toUploadable(source: string): Promise<Uploadable> {
  if (source.startsWith("data:")) {
    const commaIndex = source.indexOf(",");
    const meta = source.slice(5, commaIndex);
    const mime = meta.split(";")[0] || "image/png";
    const data = source.slice(commaIndex + 1);
    const bytes = meta.includes(";base64")
      ? Buffer.from(data, "base64")
      : Buffer.from(decodeURIComponent(data), "utf8");
    return toFile(new Uint8Array(bytes), "input.png", { type: mime });
  }
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new GenerationError(
        "openai",
        "api_error",
        `参考图下载失败：HTTP ${response.status}`,
      );
    }
    return toFile(new Uint8Array(await response.bytes()), "input.png", {
      type: response.headers.get("content-type") ?? "image/png",
    });
  }
  return toFile(new Uint8Array(Buffer.from(source, "base64")), "input.png", {
    type: "image/png",
  });
}

export class OpenAIImageProvider implements ImageProvider {
  readonly name = "openai";
  // TODO: 补充 models 列表后前端 image-models API 才会展示 OpenAI 模型供用户选择
  readonly models = [] as const;
  private client: OpenAI;

  constructor(
    apiKey: string,
    baseURL?: string,
    headers?: Record<string, string>,
  ) {
    this.client = new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      // 自定义头（§4.8）：authorization 等保留头由 SDK 按 apiKey 生成，不受其影响
      ...(headers ? { defaultHeaders: headers } : {}),
    });
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const { width, height } = aspectRatioToDimensions(
      params.aspectRatio ?? "1:1",
    );
    const size = `${width}x${height}`;

    try {
      // 带参考图 → 编辑路径（S5 缝）：/images/edits（multipart）；否则生成路径不变。
      const response =
        params.inputImages?.length
          ? await this.client.images.edit({
              model: params.model,
              prompt: params.prompt,
              image: await Promise.all(params.inputImages.map(toUploadable)),
              n: 1,
              size,
            })
          : await this.client.images.generate({
              model: params.model,
              prompt: params.prompt,
              size: size as "1024x1024",
              n: 1,
            });

      const url = response.data?.[0]?.url;
      if (!url) {
        throw new GenerationError(
          "openai",
          "no_output",
          "OpenAI returned no image URL",
        );
      }

      return { url, mimeType: "image/png", width, height };
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
