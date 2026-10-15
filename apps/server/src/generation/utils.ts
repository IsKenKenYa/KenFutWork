import type { GeneratedImage } from "./types.js";

/** OpenAI/Ark Images API 均可能返回 URL 或 base64，不能把同步产物误当空结果。 */
export function readGeneratedImage(
  provider: string,
  response: {
    data?: Array<{ url?: string; b64_json?: string; size?: string }>;
    output_format?: string;
  },
  defaults: { width: number; height: number; mimeType: string },
): GeneratedImage {
  const image = response.data?.[0];
  const mimeType =
    response.output_format === "png"
      ? "image/png"
      : response.output_format === "jpeg"
        ? "image/jpeg"
        : response.output_format === "webp"
          ? "image/webp"
          : defaults.mimeType;
  const url =
    image?.url ||
    (image?.b64_json ? `data:${mimeType};base64,${image.b64_json}` : undefined);
  if (!url)
    throw new GenerationError(
      provider,
      "no_output",
      "供应商未返回图片，请检查模型与生成结果。",
    );
  const actualSize = image?.size?.match(/^(\d+)x(\d+)$/);
  const width = Number(actualSize?.[1]) || defaults.width;
  const height = Number(actualSize?.[2]) || defaults.height;
  return { url, mimeType, width, height };
}

const KNOWN_RATIOS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
};

function roundTo64(value: number): number {
  return Math.round(value / 64) * 64;
}

export function aspectRatioToDimensions(
  aspectRatio: string,
  baseSize = 1024,
): { width: number; height: number } {
  const known = KNOWN_RATIOS[aspectRatio];
  if (known && baseSize === 1024) return known;

  const [wStr, hStr] = aspectRatio.split(":");
  const w = Number(wStr);
  const h = Number(hStr);
  if (!w || !h) return { width: baseSize, height: baseSize };

  const ratio = w / h;
  if (ratio >= 1) {
    return { width: roundTo64(baseSize), height: roundTo64(baseSize / ratio) };
  }
  return { width: roundTo64(baseSize * ratio), height: roundTo64(baseSize) };
}

/**
 * Fetches a resource from a URL (or data URI) and returns its base64
 * representation and MIME type. Used by Google providers to convert
 * input images/media into inline_data format.
 */
export async function fetchAsBase64(
  providerName: string,
  url: string,
): Promise<{ data: string; mimeType: string }> {
  // Already a data URI — extract inline.
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    const mimeType = match?.[1];
    const data = match?.[2];
    if (!mimeType || !data) {
      throw new GenerationError(
        providerName,
        "input_fetch_error",
        `Invalid data URI format: ${url.slice(0, 80)}`,
      );
    }
    return { mimeType, data };
  }

  // HTTP(S) URL — fetch and convert.
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new GenerationError(
      providerName,
      "input_fetch_error",
      `Failed to fetch input: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    throw new GenerationError(
      providerName,
      "input_fetch_error",
      `Failed to fetch input (HTTP ${response.status}): ${url}`,
    );
  }

  const buffer = await response.arrayBuffer();
  const data = Buffer.from(buffer).toString("base64");
  const mimeType =
    response.headers.get("content-type") ?? "application/octet-stream";

  return { data, mimeType };
}

export class GenerationError extends Error {
  readonly status: number | undefined;
  readonly retryAfter: string | undefined;
  readonly upstreamCode: string | undefined;
  constructor(
    public readonly provider: string,
    public readonly code: string,
    message: string,
    details: {
      status?: number | undefined;
      retryAfter?: string | null | undefined;
      upstreamCode?: string | null | undefined;
    } = {},
  ) {
    super(message);
    this.name = "GenerationError";
    this.status = details.status;
    this.retryAfter = details.retryAfter ?? undefined;
    this.upstreamCode = details.upstreamCode ?? undefined;
  }
}

export function generationHttpError(
  provider: string,
  response: Response,
  message: string,
  upstreamCode?: string,
) {
  return new GenerationError(provider, "api_error", message, {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    upstreamCode,
  });
}

/** SDK 的 HTTP 边界保留 Job 调度需要的安全字段，不保留请求与凭据。 */
export function createGenerationFetch(
  provider: string,
  sensitiveValues: readonly string[] = [],
): typeof fetch {
  const redact = (value: string) => {
    for (const sensitive of sensitiveValues) {
      if (sensitive) value = value.replaceAll(sensitive, "[redacted]");
    }
    return value.replace(/[\r\n\t]+/g, " ").slice(0, 500);
  };
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) return response;

    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown; status?: unknown; code?: unknown };
    } | null;
    const detail = body?.error;
    const message =
      typeof detail?.message === "string"
        ? redact(detail.message)
        : `供应商请求失败（HTTP ${response.status}）。`;
    const upstreamCode =
      typeof detail?.status === "string"
        ? detail.status
        : typeof detail?.code === "string"
          ? detail.code
          : undefined;
    throw generationHttpError(
      provider,
      response,
      message,
      upstreamCode ? redact(upstreamCode) : undefined,
    );
  };
}
