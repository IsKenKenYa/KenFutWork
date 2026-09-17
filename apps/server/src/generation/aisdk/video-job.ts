import {
  experimental_getVideoStatus,
  experimental_startVideo,
  type VideoModel,
} from "ai";

/**
 * 视频任务防腐缝（docs/future/05 §5.3 / §11，阶段 A）。
 *
 * 这是全仓**唯一**接触 `experimental_startVideo` / `experimental_getVideoStatus`
 * 的文件：把它们折叠为引擎持有的 `{submit, poll, cancel}` 契约与五态机
 * （queued / in_progress / succeeded / failed / cancelled）。SDK 的 API 变化只改
 * 本文件；executor 与 job-loop 不 import "ai"。
 *
 * 编排纪律（§11）：本文件**不做轮询循环、不设重试定时器**——poll 是单次查询，
 * 轮询节奏由引擎（阶段 C：队列延迟消息）承载。submit 传 `abortSignal` 透传给
 * SDK；取消分两层：abort 只断本地连接（云端任务继续跑），厂商取消必须走
 * `cancelProviderJob`（spec 级没有 video cancel，按协议注入）；未注入时 `cancel`
 * 抛 `video_cancel_unsupported`，由引擎做本地软取消（标记 cancelled，云端任务
 * 自然过期或由绝对超时兜底收口）。
 */

/** 五态机（拍板决议 §11）：queued / cancelled 由引擎持有，poll 只产出其余三态。 */
export type VideoJobState =
  | "queued"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "cancelled";

export type VideoJobErrorCode =
  | "video_async_unsupported"
  | "video_operation_unserializable"
  | "video_cancel_unsupported";

/** 防腐缝错误（稳定码，消费方按码路由不按文案——dsh 纪律）。 */
export class VideoJobError extends Error {
  readonly code: VideoJobErrorCode;
  constructor(code: VideoJobErrorCode, message: string) {
    super(`[video-job:${code}] ${message}`);
    this.name = "VideoJobError";
    this.code = code;
  }
}

/** 帧图（首尾帧）：string 覆盖 URL / data URL / base64，Uint8Array 为原始字节。 */
export interface VideoJobFrameImage {
  image: string | Uint8Array;
  frameType: "first_frame" | "last_frame";
}

/** 提交参数（ACL 自有形状，只含引擎实际透传的字段）。 */
export interface VideoJobSubmitParams {
  prompt: string;
  n?: number;
  aspectRatio?: `${number}:${number}` | "adaptive";
  resolution?: `${number}x${number}`;
  duration?: number;
  fps?: number;
  seed?: number;
  frameImages?: VideoJobFrameImage[];
  /** 参考图 / 参考视频输入（URL 或原始字节）。 */
  inputReferences?: Array<string | Uint8Array>;
  generateAudio?: boolean;
  /** 厂商专有参数（`{ [providerKey]: {...} }`，原样透传）。 */
  providerOptions?: Record<string, Record<string, unknown>>;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  /** start 调用的重试上限（SDK 内建重试；默认 2，0 关闭）。 */
  maxRetries?: number;
}

/**
 * 提交产物：`operation` 是厂商的不透明任务引用（如 task id / prediction URL），
 * **必须可 JSON 序列化**——阶段 C 要把它落库做崩溃恢复；warnings 归一为字符串。
 */
export interface VideoJobHandle {
  operation: unknown;
  warnings: string[];
}

/** 轮询结果：引擎只认这三态（queued 是落库初值，cancelled 由取消路径产生）。 */
export type VideoJobPollResult =
  | { state: "in_progress" }
  | {
      state: "succeeded";
      videos: Array<
        | { type: "url"; url: string; mediaType: string }
        | { type: "base64"; data: string; mediaType: string }
        | { type: "binary"; data: Uint8Array; mediaType: string }
      >;
      warnings: string[];
    }
  | { state: "failed"; errorMessage: string };

export interface VideoJobPollOptions {
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}

/** 厂商取消端点（按协议注入）：只收 operation，成功即云端任务被撤销。 */
export type VideoJobCancelProvider = (
  operation: unknown,
  options?: VideoJobPollOptions,
) => Promise<void>;

export interface VideoJobDriver {
  submit(params: VideoJobSubmitParams): Promise<VideoJobHandle>;
  poll(
    operation: unknown,
    options?: VideoJobPollOptions,
  ): Promise<VideoJobPollResult>;
  cancel(operation: unknown, options?: VideoJobPollOptions): Promise<void>;
}

function serializeOperation(operation: unknown): string {
  let serialized: string;
  try {
    // JSON.stringify 对顶层 function/symbol/undefined **返回** undefined 而不抛错
    //（BigInt 等才抛 TypeError），两种情况都必须显式拦下。
    serialized = JSON.stringify(operation) ?? "";
  } catch {
    throw new VideoJobError(
      "video_operation_unserializable",
      "厂商返回的任务引用不可 JSON 序列化，无法持久化（崩溃恢复前提）",
    );
  }
  if (serialized === "") {
    throw new VideoJobError(
      "video_operation_unserializable",
      "任务引用序列化后为空（顶层为 function/symbol/undefined），无法持久化",
    );
  }
  return serialized;
}

/** 引擎落库前的确定性校验：operation 必须能安全往返 JSON（崩溃恢复的前提）。 */
export function assertOperationSerializable(operation: unknown): void {
  serializeOperation(operation);
}

function warningsToMessages(warnings: readonly unknown[]): string[] {
  return warnings.map((warning) => {
    if (
      typeof warning === "object" &&
      warning !== null &&
      "message" in warning &&
      typeof (warning as { message?: unknown }).message === "string"
    ) {
      return (warning as { message: string }).message;
    }
    if (
      typeof warning === "object" &&
      warning !== null &&
      "type" in warning &&
      typeof (warning as { type?: unknown }).type === "string"
    ) {
      return (warning as { type: string }).type;
    }
    return String(warning);
  });
}

/** 模型是否实现异步任务面（spec 级 `doStart`）；纯同步模型只能走阻塞式生成。 */
function supportsAsyncStart(model: VideoModel): boolean {
  return (
    "doStart" in model &&
    typeof (model as { doStart?: unknown }).doStart === "function"
  );
}

/**
 * 提交异步视频任务。不传 `webhookUrl`（桌面自托管无公网入口，纯 poll 路径，
 * §5.2）。
 */
export async function submitVideoJob(
  model: VideoModel,
  params: VideoJobSubmitParams,
): Promise<VideoJobHandle> {
  if (!supportsAsyncStart(model)) {
    throw new VideoJobError(
      "video_async_unsupported",
      `模型 ${String(model.modelId)} 未实现异步任务面（doStart），无法接入持久化任务链`,
    );
  }
  const result = await experimental_startVideo({
    model,
    prompt: params.prompt,
    ...(params.n === undefined ? {} : { n: params.n }),
    ...(params.aspectRatio === undefined ? {} : { aspectRatio: params.aspectRatio }),
    ...(params.resolution === undefined ? {} : { resolution: params.resolution }),
    ...(params.duration === undefined ? {} : { duration: params.duration }),
    ...(params.fps === undefined ? {} : { fps: params.fps }),
    ...(params.seed === undefined ? {} : { seed: params.seed }),
    ...(params.frameImages === undefined
      ? {}
      : {
          frameImages: params.frameImages.map((frame) => ({
            image: frame.image,
            frameType: frame.frameType,
          })),
        }),
    ...(params.inputReferences === undefined
      ? {}
      : { inputReferences: params.inputReferences }),
    ...(params.generateAudio === undefined
      ? {}
      : { generateAudio: params.generateAudio }),
    ...(params.providerOptions === undefined
      ? {}
      : { providerOptions: params.providerOptions }),
    ...(params.maxRetries === undefined ? {} : { maxRetries: params.maxRetries }),
    ...(params.abortSignal === undefined ? {} : { abortSignal: params.abortSignal }),
    ...(params.headers === undefined ? {} : { headers: params.headers }),
  });
  assertOperationSerializable(result.operation);
  return {
    operation: result.operation,
    warnings: warningsToMessages(result.warnings),
  };
}

/** 单次状态查询（不循环；返回「pending | completed | error」的三态归一）。 */
export async function pollVideoJob(
  model: VideoModel,
  operation: unknown,
  options?: VideoJobPollOptions,
): Promise<VideoJobPollResult> {
  const result = await experimental_getVideoStatus(model, {
    operation: operation as Parameters<typeof experimental_getVideoStatus>[1]["operation"],
    ...(options?.headers === undefined ? {} : { headers: options.headers }),
    ...(options?.abortSignal === undefined
      ? {}
      : { abortSignal: options.abortSignal }),
    ...(options?.maxRetries === undefined
      ? {}
      : { maxRetries: options.maxRetries }),
  });
  if (result.status === "pending") {
    return { state: "in_progress" };
  }
  if (result.status === "completed") {
    return {
      state: "succeeded",
      videos: result.videos.map((video) =>
        video.type === "url"
          ? { type: "url" as const, url: video.url, mediaType: video.mediaType }
          : video.type === "base64"
            ? { type: "base64" as const, data: video.data, mediaType: video.mediaType }
            : { type: "binary" as const, data: video.data, mediaType: video.mediaType },
      ),
      warnings: warningsToMessages(result.warnings),
    };
  }
  return { state: "failed", errorMessage: result.error };
}

/**
 * 组装任务驱动：`cancelProviderJob` 按协议注入（如 Replicate 的
 * `POST /predictions/{id}/cancel`、fal 的 cancel_url——阶段 C 接入对应厂商时补）。
 * 未注入时 `cancel` 抛 `video_cancel_unsupported`，引擎据此做本地软取消。
 */
export function createVideoJobDriver(options: {
  model: VideoModel;
  cancelProviderJob?: VideoJobCancelProvider;
}): VideoJobDriver {
  return {
    submit: (params) => submitVideoJob(options.model, params),
    poll: (operation, pollOptions) =>
      pollVideoJob(options.model, operation, pollOptions),
    cancel: async (operation, cancelOptions) => {
      if (!options.cancelProviderJob) {
        throw new VideoJobError(
          "video_cancel_unsupported",
          "该协议未注入厂商取消端点——请按本地软取消处理（标记 cancelled，云端任务由绝对超时兜底）",
        );
      }
      await options.cancelProviderJob(operation, cancelOptions);
    },
  };
}
