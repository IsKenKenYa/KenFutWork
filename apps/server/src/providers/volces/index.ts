import { VolcesImageProvider } from "../../generation/providers/volces-image.js";
import type { ImageProvider } from "../../generation/types.js";
import type { InstanceImageAdapterOptions } from "../types.js";

/** volces 线协议适配器：图像（BYOK 火山引擎 Key，支持自定义网关地址）。 */

export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const delegate = new VolcesImageProvider(
    options.credentials.apiKey,
    options.credentials.baseUrl,
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
