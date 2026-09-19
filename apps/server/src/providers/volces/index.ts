import { VolcesImageProvider } from "../../generation/providers/volces-image.js";
import { VolcesVideoProvider } from "../../generation/providers/volces-video.js";
import type { ImageProvider, VideoProvider } from "../../generation/types.js";
import type {
  InstanceImageAdapterOptions,
  InstanceVideoAdapterOptions,
} from "../types.js";

/** volces 线协议适配器：图像（BYOK 火山引擎 Key，支持自定义网关地址）。 */

export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const delegate = new VolcesImageProvider(
    options.credentials.apiKey,
    options.credentials.baseUrl,
    options.credentials.headers,
  );
  return {
    name: "volces",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
    })),
    generate: (params) => delegate.generate(params),
  };
}

/** volces 视频适配器（Seedance 系，G4 关闭项）：走 AI SDK 异步任务面。 */

export function createInstanceVideoProvider(
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const delegate = new VolcesVideoProvider(
    options.credentials.apiKey,
    options.credentials.baseUrl,
    options.credentials.headers,
  );
  return {
    name: "volces",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
      capabilities: {
        textToVideo: true,
        imageToVideo: true,
        videoToVideo: false,
        audio: false,
      },
      limits: {
        maxDuration: 15,
        maxResolution: "1080p",
        maxInputImages: 4,
      },
    })),
    generate: (params) => delegate.generate(params),
    startAsync: (params) => delegate.startAsync(params),
    pollAsync: (providerJobId) => delegate.pollAsync(providerJobId),
  };
}
