import { zcodeUiProtocol as protocol } from "@kenfutwork/shared";
import { z } from "zod";

/** 展示引用仅来自已完成Job和已登记素材，不用URL或模型文字伪造资源身份。 */
export function generatedMediaDisplay(
  input: {
    jobId: string;
    assetId?: string;
    mimeType?: string;
    width?: number;
    height?: number;
  },
  mediaType: "image" | "video",
  title?: string,
): protocol.GeneratedMediaDisplay | undefined {
  if (
    !z.uuid().safeParse(input.jobId).success ||
    !z.uuid().safeParse(input.assetId).success
  )
    return undefined;
  return protocol.generatedMediaDisplaySchema.parse({
    kind: "generated_media",
    version: 1,
    jobId: input.jobId,
    assetId: input.assetId,
    mediaType,
    mimeType:
      input.mimeType ?? (mediaType === "image" ? "image/png" : "video/mp4"),
    ...(input.width !== undefined &&
    Number.isFinite(input.width) &&
    input.width > 0
      ? { width: input.width }
      : {}),
    ...(input.height !== undefined &&
    Number.isFinite(input.height) &&
    input.height > 0
      ? { height: input.height }
      : {}),
    ...(title ? { title } : {}),
  });
}
