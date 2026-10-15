import { generationHttpError } from "../../generation/utils.js";

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

  private async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      wait?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReplicatePrediction> {
    const headers = new Headers(this.headers);
    headers.set("Authorization", `Bearer ${this.apiToken}`);
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (options.wait) headers.set("Prefer", "wait");
    else headers.delete("Prefer");
    const timeout = AbortSignal.timeout(options.wait ? 120_000 : 30_000);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
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
