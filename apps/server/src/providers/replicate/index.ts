import { ReplicateImageProvider } from "../../generation/providers/replicate-image.js";
import { ReplicateVideoProvider } from "../../generation/providers/replicate-video.js";
import type { ImageProvider, VideoProvider } from "../../generation/types.js";
import type {
  InstanceImageAdapterOptions,
  InstanceVideoAdapterOptions,
} from "../types.js";

/** replicate 线协议适配器：图像 + 视频（BYOK Replicate API Token）。 */

export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const delegate = new ReplicateImageProvider(
    options.credentials.apiKey,
    options.credentials.headers,
  );
  return {
    name: "replicate",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
    })),
    generate: (params) => delegate.generate(params),
  };
}

export function createInstanceVideoProvider(
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const delegate = new ReplicateVideoProvider(
    options.credentials.apiKey,
    options.credentials.headers,
  );
  return {
    name: "replicate",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
      capabilities: {
        textToVideo: true,
        imageToVideo: false,
        videoToVideo: false,
        audio: false,
      },
      limits: {
        maxDuration: 10,
        maxResolution: "1080p",
        maxInputImages: 1,
      },
    })),
    generate: (params) => delegate.generate(params),
    startAsync: (params) => delegate.startAsync(params),
    pollAsync: (providerJobId) => delegate.pollAsync(providerJobId),
  };
}
