import {
  GenerationError,
  generationHttpError,
} from "../../generation/utils.js";

const INLINE_FILE_BYTES = 1_000_000;
const MAX_FILE_BYTES = 100_000_000;
const FILE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

type MediaInputs = {
  inputImages?: string[];
  inputVideo?: string;
  signal?: AbortSignal;
};

export interface ReplicatePrediction {
  id?: string;
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  input?: Record<string, unknown>;
}

/** 单次 Replicate 请求；调度、重试和持久化归 Job 引擎。 */
export class ReplicatePredictionsClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiToken: string,
    private readonly headers?: Record<string, string>,
    baseUrl = "https://api.replicate.com/v1",
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async prepareInputs<T extends MediaInputs>(params: T): Promise<T> {
    return {
      ...params,
      ...(params.inputImages
        ? {
            inputImages: await Promise.all(
              params.inputImages.map((source) =>
                this.prepareFile(source, params.signal),
              ),
            ),
          }
        : {}),
      ...(params.inputVideo
        ? {
            inputVideo: await this.prepareFile(
              params.inputVideo,
              params.signal,
            ),
          }
        : {}),
    };
  }

  private async prepareFile(
    source: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!source.startsWith("data:")) return source;
    const comma = source.indexOf(",");
    const match = /^data:([^;,]+);base64$/i.exec(source.slice(0, comma));
    if (!match)
      throw new GenerationError(
        "replicate",
        "invalid_input",
        "参考素材编码无效。",
      );
    const encoded = source.slice(comma + 1);
    const size =
      Math.floor((encoded.length * 3) / 4) -
      (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (size >= MAX_FILE_BYTES)
      throw new GenerationError(
        "replicate",
        "unsupported_input",
        "Replicate参考素材必须小于100MB。",
      );
    if (size < INLINE_FILE_BYTES) return source;
    const mimeType = match[1] ?? "application/octet-stream";
    const extension = FILE_EXTENSIONS[mimeType] ?? "bin";
    const form = new FormData();
    form.append(
      "content",
      new Blob([Buffer.from(encoded, "base64")], { type: mimeType }),
      `reference.${extension}`,
    );
    try {
      const file = await this.request<{ urls?: { get?: string } }>("/files", {
        method: "POST",
        body: form,
        timeoutMs: 120_000,
        ...(signal ? { signal } : {}),
      });
      const url = file.urls?.get;
      if (!url || !/^https?:\/\//i.test(url))
        throw new Error("Replicate文件上传未返回可读取链接。");
      // URL只交给供应商读取，客户端不访问它，也不向它附加供应商凭据。
      return url;
    } catch (cause) {
      const error = new GenerationError(
        "replicate",
        "input_fetch_error",
        "参考素材上传失败，请稍后重试。",
        cause instanceof GenerationError ? cause : {},
      );
      error.cause = cause;
      throw error;
    }
  }

  create(
    model: string,
    input: Record<string, unknown>,
    options: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<ReplicatePrediction> {
    if (model.includes(":") || /^[a-f0-9]{64}$/i.test(model)) {
      return this.request("/predictions", {
        method: "POST",
        body: { version: model, input },
        ...options,
      });
    }
    const modelPath = model.split("/").map(encodeURIComponent).join("/");
    return this.request(`/models/${modelPath}/predictions`, {
      method: "POST",
      body: { input },
      ...options,
    });
  }

  get(predictionId: string): Promise<ReplicatePrediction> {
    return this.request(`/predictions/${encodeURIComponent(predictionId)}`);
  }

  async cancel(predictionId: string): Promise<void> {
    await this.request(
      `/predictions/${encodeURIComponent(predictionId)}/cancel`,
      {
        method: "POST",
      },
    );
  }

  private async request<T = ReplicatePrediction>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      wait?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const headers = new Headers(this.headers);
    headers.set("Authorization", `Bearer ${this.apiToken}`);
    const multipart = options.body instanceof FormData;
    if (multipart) headers.delete("Content-Type");
    else if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.wait) headers.set("Prefer", "wait");
    else headers.delete("Prefer");
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? (options.wait ? 120_000 : 30_000),
    );
    const body =
      options.body instanceof FormData
        ? options.body
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
      redirect: "error",
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw generationHttpError(
        "replicate",
        response,
        `Replicate API error ${response.status}: ${data?.detail ?? "Unknown error"}`,
      );
    }
    return data ?? {};
  }
}
