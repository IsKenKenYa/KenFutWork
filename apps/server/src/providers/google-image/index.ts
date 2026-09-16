import { GoogleImageProvider } from "../../generation/providers/google-image.js";
import type { ImageProvider } from "../../generation/types.js";
import type { InstanceImageAdapterOptions } from "../types.js";

/** google-image 线协议适配器：图像（BYOK Google AI Studio Key）。 */

export function createInstanceImageProvider(
  options: InstanceImageAdapterOptions,
): ImageProvider {
  const delegate = new GoogleImageProvider(
    options.credentials.apiKey,
    options.credentials.headers,
  );
  return {
    name: "google-image",
    models: options.models.map((m) => ({
      id: m.id,
      displayName: m.name,
      description: "BYOK instance model",
    })),
    generate: (params) => delegate.generate(params),
  };
}
