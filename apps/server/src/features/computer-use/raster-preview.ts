import sharp from "sharp";
import type { CuRaster } from "./executor.js";

/** PNG预览与动作坐标共用输出尺寸；窗口逻辑bounds/身份保持执行器确认值。 */
export async function fitRasterPreview(
  raster: CuRaster,
  maxBase64Bytes: number,
): Promise<CuRaster> {
  if (raster.base64.length <= maxBase64Bytes) return raster;
  const source = Buffer.from(raster.base64, "base64");
  let width = raster.width,
    height = raster.height;
  for (;;) {
    const { data, info } = await sharp(source, {
      limitInputPixels: raster.width * raster.height,
    })
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    const base64 = data.toString("base64");
    if (base64.length <= maxBase64Bytes)
      return { ...raster, width: info.width, height: info.height, base64 };
    if (width === 1 && height === 1)
      throw Object.assign(new Error("截图预算不足，请调整电脑控制截图上限。"), {
        code: "image_budget_exceeded",
        actionSent: false,
      });
    const scale = Math.min(
      0.8,
      Math.sqrt(maxBase64Bytes / base64.length) * 0.9,
    );
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
}
