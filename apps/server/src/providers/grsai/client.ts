import { z } from "zod";
import {
  GenerationError,
  generationHttpError,
  redactGenerationMessage,
} from "../../generation/utils.js";
import type { InstanceCredentials } from "../types.js";

const resultSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  results: z
    .array(
      z.object({
        url: z.string().min(1),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
});
export type GrsaiResult = z.infer<typeof resultSchema>;

/** 单次协议请求。重试、轮询、取消意图和产物持久化均由Job引擎管理。 */
export class GrsaiClient {
  private readonly baseUrl: string;
  constructor(private readonly credentials: InstanceCredentials) {
    this.baseUrl = (credentials.baseUrl ?? "https://grsaiapi.com")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
  }
  async request(
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<GrsaiResult> {
    const response = await fetch(`${this.baseUrl}/v1/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...this.credentials.headers,
        Authorization: `Bearer ${this.credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
      redirect: "error",
    });
    const value: unknown = await response.json().catch(() => null);
    const data =
      value && typeof value === "object" ? (value as Partial<GrsaiResult>) : {};
    const message = this.safeMessage(
      typeof data.error === "string"
        ? data.error
        : `GRSAI请求失败（HTTP ${response.status}），请检查供应商设置。`,
    );
    if (!response.ok)
      throw generationHttpError(
        "grsai",
        response,
        response.status === 401 || response.status === 403
          ? "GRSAI凭据无效或无权访问，请检查供应商Key与模型权限。"
          : response.status === 402
            ? "GRSAI余额不足，请到供应商检查余额或更换Key。"
            : message,
      );

    const parsed = resultSchema.safeParse(value);
    if (!parsed.success)
      throw new GenerationError(
        "grsai",
        "malformed_response",
        "GRSAI回执缺少任务、状态或有效结果，请核对供应商记录。",
      );
    return {
      ...parsed.data,
      ...(parsed.data.error !== undefined
        ? { error: this.safeMessage(parsed.data.error) }
        : {}),
    };
  }
  query(id: string) {
    return this.request(`result?id=${encodeURIComponent(id)}`);
  }
  safeMessage(message: string): string {
    return redactGenerationMessage(message, [
      this.credentials.apiKey,
      ...Object.values(this.credentials.headers ?? {}),
    ]);
  }
}

export function assertGrsaiResult(result: GrsaiResult): void {
  if (result.status === "violation")
    throw new GenerationError(
      "grsai",
      "safety_filter",
      result.error ?? "GRSAI拒绝了此内容，请调整提示词或参考素材。",
    );
  if (result.status === "failed")
    throw new GenerationError(
      "grsai",
      "provider_task_failed",
      result.error ?? "GRSAI生成失败，请核对供应商记录。",
    );
  if (!["running", "succeeded"].includes(result.status))
    throw new GenerationError(
      "grsai",
      "malformed_response",
      "GRSAI返回了未知任务状态，请核对供应商记录。",
    );
}

/** 文档明确接受裸base64；本地素材由引擎解析为Data URI后在此转为原生字段。 */
export function grsaiImages(images?: string[]): string[] | undefined {
  return images?.map((source) => {
    if (!source.startsWith("data:")) return source;
    const match = /^data:[^;]+;base64,([\s\S]+)$/.exec(source);
    if (!match?.[1])
      throw new GenerationError(
        "grsai",
        "invalid_input",
        "参考图格式无效，请重新添加图片。",
      );
    return match[1];
  });
}
