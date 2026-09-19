import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";

import { createVolcesProvider } from "../aisdk/factory.js";
import { pollVideoJob, submitVideoJob } from "../aisdk/video-job.js";
import type {
  GeneratedVideo,
  VideoAsyncPollResult,
  VideoGenerateParams,
  VideoModelInfo,
  VideoProvider,
} from "../types.js";
import { GenerationError } from "../utils.js";

/**
 * volces（火山方舟）视频 provider——Seedance 系（G4 关闭项）。
 *
 * 线路走 AI SDK 防腐缝（`aisdk/video-job.ts`：`@ai-sdk/bytedance` 的
 * `videoModel()` 实现 spec `doStart`/`doStatus`，submit+poll 自含、webhook 可绕开）。
 * 任务引用以 JSON 串持久化（`background_jobs.provider_job_id`），跨进程/重启可续查。
 *
 * 仅支持异步任务面：executor 经 `startAsync`/`pollAsync` 消费；阻塞 `generate`
 * 显式 fail loud（不做内部轮询循环——编排纪律）。
 */

// 目录声明仅供展示与定价展示（BYOK 用户实例的 models[] 才是实际授权面）。
const VOLCES_VIDEO_MODELS: readonly VideoModelInfo[] = [
  {
    id: "dreamina-seedance-2-0-260128",
    displayName: "Seedance 2.0",
    description: "豆包 Seedance 2.0：文/图生视频，支持首尾帧与音视频一体",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: true,
    },
    limits: {
      maxDuration: 15,
      allowedDurations: [4, 8, 12, 15],
      maxResolution: "1080p",
      maxInputImages: 4,
    },
  },
  {
    id: "seedance-1-5-pro-251215",
    displayName: "Seedance 1.5 Pro",
    description: "Seedance 1.5 Pro：高质感文/图生视频",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: false,
    },
    limits: {
      maxDuration: 12,
      maxResolution: "1080p",
      maxInputImages: 1,
    },
  },
  {
    id: "seedance-1-0-pro-250528",
    displayName: "Seedance 1.0 Pro",
    description: "Seedance 1.0 Pro：稳定的主力文/图生视频",
    capabilities: {
      textToVideo: true,
      imageToVideo: true,
      videoToVideo: false,
      audio: false,
    },
    limits: {
      maxDuration: 10,
      maxResolution: "1080p",
      maxInputImages: 1,
    },
  },
];

export class VolcesVideoProvider implements VideoProvider {
  readonly name = "volces";
  readonly models = VOLCES_VIDEO_MODELS;
  private readonly apiKey: string;
  private readonly baseUrl: string | undefined;
  private readonly headers: Record<string, string> | undefined;

  constructor(
    apiKey: string,
    baseUrl?: string,
    headers?: Record<string, string>,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.headers = headers;
  }

  private videoModel(modelId: string): Experimental_VideoModelV4 {
    return createVolcesProvider({
      apiKey: this.apiKey,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      ...(this.headers ? { headers: this.headers } : {}),
    }).videoModel(modelId);
  }

  async startAsync(
    params: VideoGenerateParams,
  ): Promise<{ providerJobId: string }> {
    const submit = await submitVideoJob(this.videoModel(params.model), {
      prompt: params.prompt,
      ...(params.duration != null ? { duration: params.duration } : {}),
      // spec 的 aspectRatio 形如 `${number}:${number}`；非常规值交给上层校验拒绝
      ...(params.aspectRatio
        ? { aspectRatio: params.aspectRatio as `${number}:${number}` }
        : {}),
      // 图生视频：参考图作首帧（Seedance i2v 语义）
      ...(params.inputImages?.length
        ? {
            frameImages: [
              {
                image: params.inputImages[0] as string | Uint8Array,
                frameType: "first_frame" as const,
              },
            ],
          }
        : {}),
      ...(params.enableAudio != null
        ? { generateAudio: params.enableAudio }
        : {}),
    });
    // 任务引用统一 JSON 串持久化（列是 text；parse 还原后原样传回 poll）
    return { providerJobId: JSON.stringify(submit.operation) };
  }

  async pollAsync(providerJobId: string): Promise<VideoAsyncPollResult> {
    let operation: unknown;
    try {
      operation = JSON.parse(providerJobId);
    } catch {
      throw new GenerationError(
        "volces",
        "malformed_response",
        "持久化的任务引用不是合法 JSON（可能被手改）",
      );
    }
    const result = await pollVideoJob(this.videoModel(""), operation);
    if (result.state === "succeeded") {
      const urlVideo = result.videos.find((video) => video.type === "url");
      if (!urlVideo) {
        return {
          state: "failed",
          errorMessage:
            "Seedance 返回的产物不是可下载 URL（base64/二进制产物暂不支持直落）",
        };
      }
      return { state: "succeeded", videoUrl: urlVideo.url };
    }
    if (result.state === "failed") {
      return { state: "failed", errorMessage: result.errorMessage };
    }
    return { state: "in_progress" };
  }

  async generate(_params: VideoGenerateParams): Promise<GeneratedVideo> {
    throw new GenerationError(
      "volces",
      "unsupported",
      "volces 视频仅支持异步任务面（submit + 队列轮询），不走阻塞生成",
    );
  }
}
