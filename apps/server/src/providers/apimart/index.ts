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
import { ApimartClient } from "./client.js";

function unsupported(message: string): never {
  throw new GenerationError("apimart", "unsupported_parameter", message);
}
function imageBody(params: ImageGenerateParams): Record<string, unknown> {
  const gpt = params.model.startsWith("gpt-image-");
  const count = params.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > (gpt ? 4 : 1))
    unsupported("此模型不支持当前单次数量，请核对模型的多图上限。");
  if (params.width !== undefined || params.height !== undefined)
    unsupported("此APIMart接口使用画幅比例，请清除像素尺寸并选择画幅。");
  if ((params.inputImages?.length ?? 0) > (gpt ? 15 : 14))
    unsupported("参考图数量超过模型上限，请减少图片。");
  if (!gpt && params.outputFormat)
    unsupported("此模型未声明输出格式，请清除格式参数。");
  if (params.outputFormat === "webp")
    unsupported("此APIMart模型不支持WebP，请选择PNG或JPG。");
  return {
    model: params.model,
    prompt: params.prompt,
    n: count,
    ...(params.aspectRatio ? { size: params.aspectRatio } : {}),
    ...(params.quality
      ? { [gpt ? "quality" : "resolution"]: params.quality }
      : {}),
    ...(params.outputFormat
      ? { output_format: params.outputFormat === "jpg" ? "jpeg" : "png" }
      : {}),
    ...(params.inputImages?.length ? { image_urls: params.inputImages } : {}),
  };
}
export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const client = new ApimartClient(options.credentials);
  return {
    name: "apimart",
    supportsAsyncBatch: true,
    models: options.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      description: "APIMart实例图片模型",
    })),
    async prepareInputs(params) {
      imageBody(params);
      return params.model.startsWith("gpt-image-") && params.inputImages?.length
        ? {
            ...params,
            inputImages: await client.publicImages(
              params.inputImages,
              params.signal,
            ),
          }
        : params;
    },
    async generate() {
      throw new GenerationError(
        "apimart",
        "invalid_input",
        "APIMart图片需通过异步Job生成。",
      );
    },
    startAsync: (params) => {
      if (
        params.model.startsWith("gpt-image-") &&
        params.inputImages?.some((source) => !/^https?:\/\//i.test(source))
      )
        unsupported("此模型需先上传参考图，请重新准备图片后提交。");
      return client.submit(
        "images/generations",
        imageBody(params),
        params.signal,
      );
    },
    async pollAsync(id) {
      const task = await client.query(id);
      if (task.status !== "completed") return { state: "in_progress" };
      const urls = task.result?.images?.flatMap((item) => item.url) ?? [];
      if (!urls.length)
        throw new GenerationError(
          "apimart",
          "no_output",
          "APIMart未返回图片，请核对生成结果。",
        );
      return {
        state: "succeeded",
        images: urls.map((url) => ({
          url,
          width: 1024,
          height: 1024,
          mimeType: /\.jpe?g(?:\?|$)/i.test(url) ? "image/jpeg" : "image/png",
        })),
      };
    },
  };
}

function videoBody(params: VideoGenerateParams): Record<string, unknown> {
  if (params.inputVideo !== undefined)
    unsupported("此APIMart视频接入未声明参考视频，请移除参考视频。");
  if (params.enableAudio !== undefined)
    unsupported("此APIMart视频接口未声明音频开关，请清除该参数。");
  if (params.model.startsWith("veo3.1-")) {
    if (params.duration !== undefined && params.duration !== 8)
      unsupported("Veo仅支持8秒，请修改时长。");
    if (params.aspectRatio && !["16:9", "9:16"].includes(params.aspectRatio))
      unsupported("Veo仅支持16:9或9:16，请修改画幅。");
    if (
      params.resolution &&
      !["720p", "1080p", "4k"].includes(params.resolution)
    )
      unsupported("Veo分辨率无效，请检查模型参数。");
    if (
      (params.inputImages?.length ?? 0) > 3 ||
      (params.model.includes("lite") && params.inputImages?.length)
    )
      unsupported("此Veo模型不支持当前参考图，请核对模型或减少图片。");
    if (
      params.model.includes("quality") &&
      (params.inputImages?.length ?? 0) > 2
    )
      unsupported("Veo Quality不支持参考图模式，请使用首尾帧或切换模型。");
  }
  return {
    model: params.model,
    prompt: params.prompt,
    ...(params.duration !== undefined ? { duration: params.duration } : {}),
    ...(params.resolution ? { resolution: params.resolution } : {}),
    ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
    ...(params.inputImages?.length ? { image_urls: params.inputImages } : {}),
  };
}
export function createInstanceVideoProvider(
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const client = new ApimartClient(options.credentials);
  return {
    name: "apimart",
    models: options.models.map((model) => ({
      id: model.id,
      displayName: model.name,
      description: "APIMart实例视频模型",
      capabilities: {},
      limits: {},
    })),
    async prepareInputs(params) {
      videoBody(params);
      return params.inputImages?.length
        ? {
            ...params,
            inputImages: await client.publicImages(
              params.inputImages,
              params.signal,
            ),
          }
        : params;
    },
    async generate() {
      throw new GenerationError(
        "apimart",
        "invalid_input",
        "APIMart视频需通过异步Job生成。",
      );
    },
    startAsync: (params) => {
      if (params.inputImages?.some((source) => !/^https?:\/\//i.test(source)))
        unsupported("此模型需先上传参考图，请重新准备图片后提交。");
      return client.submit(
        "videos/generations",
        videoBody(params),
        params.signal,
      );
    },
    async pollAsync(id) {
      const task = await client.query(id);
      if (task.status !== "completed") return { state: "in_progress" };
      const videoUrl = task.result?.videos?.flatMap((item) => item.url)[0];
      if (!videoUrl)
        throw new GenerationError(
          "apimart",
          "no_output",
          "APIMart未返回视频，请核对生成结果。",
        );
      return { state: "succeeded", videoUrl };
    },
  };
}
