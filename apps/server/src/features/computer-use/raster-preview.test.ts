import { randomBytes } from "node:crypto";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { fitRasterPreview } from "./raster-preview.js";

it.each([16_384, 262_144])(
  "%i预算下大PNG仍提供完整可解码预览并保存帧身份与桌面坐标边界",
  async (budget) => {
    const image = new PNG({ width: 1024, height: 512 });
    image.data = randomBytes(image.width * image.height * 4);
    const raster = {
      frameId: "large-frame",
      mimeType: "image/png" as const,
      width: image.width,
      height: image.height,
      base64: PNG.sync.write(image).toString("base64"),
      blackFrame: false,
      bounds: [-512, 80, 512, 256] as [number, number, number, number],
      binding: "window-1",
    };
    const preview = await fitRasterPreview(raster, budget);
    expect(preview.base64.length).toBeLessThanOrEqual(budget);
    const decoded = PNG.sync.read(Buffer.from(preview.base64, "base64"));
    expect([decoded.width, decoded.height]).toEqual([
      preview.width,
      preview.height,
    ]);
    expect(preview.width).toBeLessThan(raster.width);
    expect(preview).toMatchObject({
      frameId: raster.frameId,
      binding: raster.binding,
      bounds: raster.bounds,
    });
    expect(preview.width / preview.height).toBeCloseTo(2, 1);
  },
);

it("预算内PNG保持原帧与像素，二次处理预览不再缩小", async () => {
  const image = new PNG({ width: 8, height: 4 });
  image.data.fill(255);
  const raster = {
    frameId: "small",
    mimeType: "image/png" as const,
    width: 8,
    height: 4,
    base64: PNG.sync.write(image).toString("base64"),
    blackFrame: false,
  };
  expect(await fitRasterPreview(raster, raster.base64.length)).toBe(raster);
});
