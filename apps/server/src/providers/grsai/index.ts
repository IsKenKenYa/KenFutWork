import type {
  ImageGenerateParams,
  ImageProvider,
  VideoGenerateParams,
  VideoProvider,
} from "../../generation/types.js";
import { GenerationError } from "../../generation/utils.js";
import type {
  InstanceImageAdapterOptions,
  InstanceVideoAdapterOptions,
} from "../types.js";
import {
  assertGrsaiResult,
  GrsaiClient,
  type GrsaiResult,
  grsaiImages,
} from "./client.js";

function unsupported(message: string): never {
  throw new GenerationError("grsai", "unsupported_parameter", message);
}
function imageBody(params: ImageGenerateParams): Record<string, unknown> {
  if (params.outputFormat !== undefined)
    unsupported("此GRSAI接口不支持指定格式，请清除格式参数。");
  if ((params.count ?? 1) !== 1)
    unsupported(
      "此GRSAI接口单次只提交一张图片，请使用生成器的数量设置拆分任务。",
    );
  const gpt = params.model.startsWith("gpt-image-");
  const pixels = params.width !== undefined || params.height !== undefined;
  if (pixels && (!gpt || !params.width || !params.height))
    unsupported("此模型不支持当前像素尺寸，请检查模型参数。");
  const quality = params.quality
    ? gpt
      ? params.quality
      : ({ standard: "1K", hd: "2K", ultra: "4K" }[params.quality] ??
        params.quality)
    : undefined;
  if (!gpt && quality && !["1K", "2K", "4K"].includes(quality))
    unsupported("GRSAI图片分辨率无效，请选择1K、2K或4K。");
  return {
    model: params.model,
    prompt: params.prompt,
    ...(params.inputImages?.length
      ? { images: grsaiImages(params.inputImages) }
      : {}),
    ...(pixels
      ? { aspectRatio: `${params.width}x${params.height}` }
      : params.aspectRatio
        ? { aspectRatio: params.aspectRatio }
        : {}),
    ...(quality ? { [gpt ? "quality" : "imageSize"]: quality } : {}),
  };
}
function images(result: GrsaiResult) {
  const outputs =
    result.results?.filter(
      (item) => typeof item.url === "string" && item.url.length > 0,
    ) ?? [];
  if (!outputs.length)
    throw new GenerationError(
      "grsai",
      "no_output",
      "GRSAI未返回图片，请核对生成结果。",
    );
  return outputs.map((item) => ({
    url: item.url,
    mimeType: /\.webp(?:\?|$)/i.test(item.url)
      ? "image/webp"
      : /\.jpe?g(?:\?|$)/i.test(item.url)
        ? "image/jpeg"
        : "image/png",
    width: item.width ?? 1024,
    height: item.height ?? 1024,
  }));
}
export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const client = new GrsaiClient(options.credentials);
  return {
    name: "grsai",
    models: options.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      description: "GRSAI实例图片模型",
    })),
    async prepareInputs(params) {
      imageBody(params);
      return params;
    },
    async generate(params) {
      const result = await client.request(
        "generate",
        { ...imageBody(params), replyType: "json" },
        params.signal,
      );
      assertGrsaiResult(result);
      const first = images(result)[0];
      if (!first)
        throw new GenerationError(
          "grsai",
          "no_output",
          "GRSAI未返回图片，请核对生成结果。",
        );
      return first;
    },
    async startAsync(params) {
      const result = await client.request(
        "generate",
        { ...imageBody(params), replyType: "async" },
        params.signal,
      );
      assertGrsaiResult(result);
      return { providerJobId: result.id };
    },
    async pollAsync(id) {
      const result = await client.query(id);
      assertGrsaiResult(result);
      return result.status === "running"
        ? { state: "in_progress" }
        : { state: "succeeded", images: images(result) };
    },
  };
}

function videoBody(params: VideoGenerateParams): Record<string, unknown> {
  if (params.inputVideo !== undefined)
    unsupported("此GRSAI接口未声明参考视频，请移除参考视频。");
  if (params.enableAudio !== undefined)
    unsupported("此GRSAI接口未声明音频开关，请清除该参数。");
  if (
    params.duration === undefined ||
    !params.resolution ||
    !params.aspectRatio
  )
    throw new GenerationError(
      "grsai",
      "invalid_input",
      "GRSAI视频需要时长、分辨率和比例，请补全模型参数。",
    );
  const h3 = params.model === "minimax-h3";
  const aspectRatio = h3
    ? ({ "16:9": "landscape", "9:16": "portrait" }[params.aspectRatio] ??
      params.aspectRatio)
    : params.aspectRatio;
  const maxImages = h3 ? 9 : params.model === "agnes-video-2.5" ? 5 : undefined;
  if (maxImages !== undefined && (params.inputImages?.length ?? 0) > maxImages)
    unsupported(`此模型最多支持${maxImages}张参考图，请减少参考图。`);
  if (
    h3 &&
    (!["portrait", "landscape"].includes(aspectRatio) ||
      !["480p", "768p", "1080p"].includes(params.resolution) ||
      !Number.isInteger(params.duration) ||
      params.duration < 1 ||
      params.duration > (params.resolution === "1080p" ? 10 : 15))
  )
    unsupported("GRSAI H3参数无效，请检查比例、分辨率与时长。");
  return {
    model: params.model,
    prompt: params.prompt,
    duration: params.duration,
    resolution: params.resolution,
    aspectRatio,
    ...(params.inputImages?.length
      ? { images: grsaiImages(params.inputImages) }
      : {}),
  };
}
function videoUrl(result: GrsaiResult): string {
  const url = result.results?.[0]?.url;
  if (!url)
    throw new GenerationError(
      "grsai",
      "no_output",
      "GRSAI未返回视频，请核对生成结果。",
    );
  return url;
}
export function createInstanceVideoProvider(
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const client = new GrsaiClient(options.credentials);
  return {
    name: "grsai",
    models: options.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      description: "GRSAI实例视频模型",
      capabilities: {},
      limits: {},
    })),
    async prepareInputs(params) {
      videoBody(params);
      return params;
    },
    async generate(params) {
      const result = await client.request(
        "generate",
        { ...videoBody(params), replyType: "json" },
        params.signal,
      );
      assertGrsaiResult(result);
      return {
        url: videoUrl(result),
        mimeType: "video/mp4",
        width:
          params.aspectRatio === "9:16" || params.aspectRatio === "portrait"
            ? 576
            : 1024,
        height:
          params.aspectRatio === "9:16" || params.aspectRatio === "portrait"
            ? 1024
            : 576,
        durationSeconds: params.duration ?? 0,
      };
    },
    async startAsync(params) {
      const result = await client.request(
        "generate",
        { ...videoBody(params), replyType: "async" },
        params.signal,
      );
      assertGrsaiResult(result);
      return { providerJobId: result.id };
    },
    async pollAsync(id) {
      const result = await client.query(id);
      assertGrsaiResult(result);
      return result.status === "running"
        ? { state: "in_progress" }
        : { state: "succeeded", videoUrl: videoUrl(result) };
    },
  };
}
