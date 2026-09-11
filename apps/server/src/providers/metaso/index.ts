import { MetasoVideoProvider } from "../../generation/providers/metaso-video.js";
import type { VideoProvider } from "../../generation/types.js";
import type { InstanceVideoAdapterOptions } from "../types.js";

/** metaso 线协议适配器：视频（MiniMax H3，BYOK Metaso Key）。 */

export function createInstanceVideoProvider(
  options: InstanceVideoAdapterOptions,
): VideoProvider {
  const delegate = new MetasoVideoProvider(
    options.credentials.apiKey,
    options.credentials.baseUrl,
  );
  return {
    name: "metaso",
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
  };
}
