import { getImageProvider } from "./providers/registry.js";
import type { GeneratedImage, ImageGenerateParams } from "./types.js";

export async function generateImage(
  providerName: string,
  params: ImageGenerateParams,
): Promise<GeneratedImage> {
  const provider = getImageProvider(providerName);
  return provider.generate(params);
}
