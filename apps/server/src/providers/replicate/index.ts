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
    options.credentials.baseUrl,
  );
  return {
    name: "replicate",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
    })),
    generate: (params) => delegate.generate(params),
    startAsync: (params) => delegate.startAsync(params),
    pollAsync: (providerJobId) => delegate.pollAsync(providerJobId),
    cancelAsync: (providerJobId) => delegate.cancelAsync(providerJobId),
  };
}

export function createInstanceVideoProvider(
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const delegate = new ReplicateVideoProvider(
    options.credentials.apiKey,
    options.credentials.headers,
    options.credentials.baseUrl,
  );
  return {
    name: "replicate",
    models: options.models.map((m) => ({
      ...(delegate.models.find((known) => known.id === m.id) ?? {
        description: "BYOK instance model",
        capabilities: {},
        limits: {},
      }),
      id: m.id,
      displayName: m.name,
    })),
    generate: (params) => delegate.generate(params),
    startAsync: (params) => delegate.startAsync(params),
    pollAsync: (providerJobId) => delegate.pollAsync(providerJobId),
    cancelAsync: (providerJobId) => delegate.cancelAsync(providerJobId),
  };
}
