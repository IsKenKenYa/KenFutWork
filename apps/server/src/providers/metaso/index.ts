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
    options.credentials.headers ? { headers: options.credentials.headers } : {},
  );
  const model = delegate.models[0];
  return {
    name: "metaso",
    models: options.models.map((m) => ({
      ...model,
      id: m.id,
      displayName: m.name,
    })),
    generate: (params) => delegate.generate(params),
    startAsync: (params) => delegate.startAsync(params),
    pollAsync: (providerJobId) => delegate.pollAsync(providerJobId),
  };
}
