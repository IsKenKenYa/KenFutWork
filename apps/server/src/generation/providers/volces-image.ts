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
    this.baseURL = (baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.headers = headers;
  }

  async generate(params: ImageGenerateParams): Promise<GeneratedImage> {
    if ((params.width != null) !== (params.height != null)) {
      throw new GenerationError(
        "volces",
        "invalid_input",
        "图片宽高需同时填写，请补齐宽度和高度。",
      );
    }
    const aspectRatio = params.aspectRatio ?? "1:1";
    const [rw, rh] = aspectRatio.split(":").map(Number);
    const ratio = rw && rh ? Math.max(rw / rh, rh / rw) : 1;
    // 新版 Seedream 以总像素限定下限；不能把长边 1K 当作合法的默认请求。
    const pixels = params.quality === "ultra" ? 16_000_000 : 4_194_304;
    const baseSize = params.model.includes("seedream-3-")
      ? 1024
      : Math.sqrt(pixels * ratio);
    const { width, height } =
      params.width != null && params.height != null
        ? { width: params.width, height: params.height }
        : aspectRatioToDimensions(aspectRatio, baseSize);

    const body = {
      model: params.model,
      prompt: params.prompt,
      size: `${width}x${height}`,
      ...(params.inputImages?.length ? { image: params.inputImages } : {}),
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
      data?: Array<{ url?: string; b64_json?: string; size?: string }>;
    };
    return readGeneratedImage("volces", data, {
      width,
      height,
      mimeType: "image/png",
    });
  }
}
