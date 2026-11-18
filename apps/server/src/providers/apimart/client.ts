import { z } from "zod";
import {
  createGenerationFetch,
  GenerationError,
  redactGenerationMessage,
} from "../../generation/utils.js";
import type { InstanceCredentials } from "../types.js";

const submissionSchema = z.object({
  data: z.array(z.object({ task_id: z.string().min(1) })).length(1),
});
const resultItems = z.array(z.object({ url: z.array(z.string().min(1)) }));
const taskSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    status: z.enum([
      "pending",
      "processing",
      "completed",
      "failed",
      "cancelled",
    ]),
    result: z
      .object({
        images: resultItems.optional(),
        videos: resultItems.optional(),
      })
      .nullish(),
    error: z.object({ message: z.string().optional() }).nullish(),
  }),
});
export type ApimartTask = z.infer<typeof taskSchema>["data"];

/** 只进行一次线协议请求；共享Job拥有轮询、重试和保存。 */
export class ApimartClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly sensitiveValues: string[];
  constructor(private readonly credentials: InstanceCredentials) {
    this.baseUrl = (credentials.baseUrl ?? "https://api.apimart.ai")
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    this.sensitiveValues = [
      credentials.apiKey,
      ...Object.values(credentials.headers ?? {}),
    ];
    this.fetcher = createGenerationFetch("apimart", this.sensitiveValues);
  }
  message(value: string) {
    return redactGenerationMessage(value, this.sensitiveValues);
  }
  async request(
    path: string,
    body?: Record<string, unknown> | FormData,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const multipart = body instanceof FormData;
    const response = await this.fetcher(`${this.baseUrl}/v1/${path}`, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: {
        ...this.credentials.headers,
        Authorization: `Bearer ${this.credentials.apiKey}`,
        ...(body && !multipart ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    }).catch((error: unknown) => {
      if (
        error instanceof GenerationError &&
        [401, 402, 403].includes(error.status ?? 0)
      ) {
        error.message =
          error.status === 402
            ? "APIMart余额不足，请检查供应商余额或更换Key。"
            : "APIMart凭据无效或无权访问，请检查Key与模型权限。";
      }
      throw error;
    });
    const value: unknown = await response.json().catch(() => null);
    const envelope = z.object({ code: z.number().optional() }).safeParse(value);
    if (
      !envelope.success ||
      (envelope.data.code !== undefined && envelope.data.code !== 200)
    )
      throw new GenerationError(
        "apimart",
        "malformed_response",
        "APIMart回执无效，请核对供应商任务记录。",
      );
    return value;
  }
  async publicImages(
    images: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    return Promise.all(
      images.map(async (source) => {
        if (!source.startsWith("data:")) {
          if (!/^https?:\/\//i.test(source))
            throw new GenerationError(
              "apimart",
              "invalid_input",
              "参考图链接无效，请重新添加图片。",
            );
          return source;
        }
        const parts =
          /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/]+={0,2})$/i.exec(
            source,
          );
        if (!parts?.[1] || !parts[2])
          throw new GenerationError(
            "apimart",
            "invalid_input",
            "APIMart参考图格式无效，请选择PNG、JPG、WebP或GIF。",
          );
        const bytes = Buffer.from(parts[2], "base64");
        if (bytes.length > 20 * 1024 * 1024)
          throw new GenerationError(
            "apimart",
            "invalid_input",
            "APIMart参考图不能超过20MB，请缩小图片。",
          );
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(bytes)], { type: parts[1] }),
          `reference.${parts[1].split("/")[1]}`,
        );
        const uploaded = z
          .object({ url: z.url() })
          .safeParse(await this.request("uploads/images", form, signal));
        if (!uploaded.success || !/^https?:\/\//i.test(uploaded.data.url))
          throw new GenerationError(
            "apimart",
            "malformed_response",
            "APIMart上传未返回有效链接，请重新添加参考图。",
          );
        return uploaded.data.url;
      }),
    );
  }
  async submit(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const value = submissionSchema.safeParse(
      await this.request(path, body, signal),
    );
    if (!value.success)
      throw new GenerationError(
        "apimart",
        "malformed_response",
        "APIMart未返回唯一任务编号，请核对供应商记录。",
      );
    return { providerJobId: value.data.data[0]!.task_id };
  }
  async query(id: string): Promise<ApimartTask> {
    const parsed = taskSchema.safeParse(
      await this.request(`tasks/${encodeURIComponent(id)}`),
    );
    if (!parsed.success)
      throw new GenerationError(
        "apimart",
        "malformed_response",
        "APIMart查询回执无效，请核对供应商任务记录。",
      );
    const task = parsed.data.data;
    if (task.status === "failed" || task.status === "cancelled")
      throw new GenerationError(
        "apimart",
        "provider_task_failed",
        task.status === "cancelled"
          ? "供应商已取消此任务。"
          : this.message(
              task.error?.message ?? "APIMart生成失败，请核对供应商任务记录。",
            ),
      );
    return task;
  }
}
