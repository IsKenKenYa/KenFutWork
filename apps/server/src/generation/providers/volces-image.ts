import type {
  GeneratedImage,
  ImageGenerateParams,
  ImageProvider,
} from "../types.js";
import { aspectRatioToDimensions, GenerationError } from "../utils.js";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

export class VolcesImageProvider implements ImageProvider {
  readonly name = "volces";
  // TODO: 补充 models 列表后前端 image-models API 才会展示 Volces 模型供用户选择
  readonly models = [] as const;
  private apiKey: string;
  private baseURL: string;
  private headers: Record<string, string> | undefined;

  constructor(
    apiKey: string,
    baseURL?: string,
    headers?: Record<string, string>,
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL ?? DEFAULT_BASE_URL;
    this.headers = headers;
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    const { width, height } = aspectRatioToDimensions(
      params.aspectRatio ?? "1:1",
    );

    const body = {
      model: params.model,
      prompt: params.prompt,
      size: `${width}x${height}`,
      n: 1,
    };

    const response = await fetch(`${this.baseURL}/images/generations`, {
      method: "POST",
      headers: {
        // 自定义头（§4.8）在前，凭证与内容类型随后——保留头永远由适配器说了算
        ...this.headers,
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new GenerationError(
        "volces",
        "api_error",
        `Volces API error ${response.status}: ${(errorBody as { error?: { message?: string } })?.error?.message ?? "Unknown error"}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ url?: string; b64_json?: string }>;
    };
    const imageData = data.data[0];
    const url = imageData?.url;

    if (!url) {
      throw new GenerationError(
        "volces",
        "no_output",
        "Volces returned no image URL",
      );
    }

    return { url, mimeType: "image/png", width, height };
  }
}
