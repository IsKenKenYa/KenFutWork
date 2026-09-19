import OpenAI from "openai";

import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
} from "../types.js";
import { aspectRatioToDimensions, GenerationError } from "../utils.js";

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
      ...(baseURL ? { baseURL } : {}),
      // 自定义头（§4.8）：authorization 等保留头由 SDK 按 apiKey 生成，不受其影响
      ...(headers ? { defaultHeaders: headers } : {}),
    });
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.headers = headers;
  }

  /**
   * 编辑路径（S5 缝）：/images/edits。刻意不走 SDK 的 images.edit——其内部对
   * uploadable 的处理不可控（实测会把 blob 交给全局 fetch 去取），手写
   * multipart 与 volces-image 同风格：自定义头在前、凭证随后、形状可抓包锁定。
   */
  private async generateEdit(
    params: ImageGenerateParams,
    size: string,
  ): Promise<GeneratedImage> {
    const baseURL = this.baseURL ?? "https://api.openai.com/v1";
    const form = new FormData();
    form.append("model", params.model);
    form.append("prompt", params.prompt);
    form.append("n", "1");
    form.append("size", size);
    for (const source of params.inputImages ?? []) {
      form.append("image", await toUploadFile(source));
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
    const url = data.data[0]?.url;
    if (!url) {
      throw new GenerationError(
        "openai",
        "no_output",
        "OpenAI edits returned no image URL",
      );
    }
    const { width, height } = aspectRatioToDimensions(
      params.aspectRatio ?? "1:1",
    );
    return { url, mimeType: "image/png", width, height };
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const { width, height } = aspectRatioToDimensions(
      params.aspectRatio ?? "1:1",
    );
    const size = `${width}x${height}`;

    try {
      // 带参考图 → 编辑路径；否则生成路径不变。
      if (params.inputImages?.length) {
        return await this.generateEdit(params, size);
      }

      const response = await this.client.images.generate({
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
