import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, it } from "vitest";
import { createCadPreviewResult, rasterizeCadSvg } from "./preview.js";
import { createCadTestContext } from "./test-fixtures.js";

const roots: string[] = [];
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="-25 -36 36 40"><g fill="none" stroke="black" stroke-width="0.1" transform="scale(1,-1)"><path d="M 0 0 L -21.2132 12.2474 L -21.2132 28.5774 L -14.1421 32.6599 L 7.07107 20.4124 L 7.07107 4.08248 Z" /></g></svg>';
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("官方投影样式与负Y viewBox可生成非空PNG，空白或外部资源不能冒充预览", async () => {
  const bytes = await rasterizeCadSvg(svg);
  const png = PNG.sync.read(bytes);
  expect([png.width, png.height]).toEqual([1024, 768]);
  let dark = 0;
  for (let offset = 0; offset < png.data.length; offset += 4)
    if ((png.data[offset] ?? 255) < 240) dark += 1;
  expect(dark).toBeGreaterThan(100);
  expect(dark).toBeLessThan((png.width * png.height) / 10);
  await expect(
    rasterizeCadSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"></svg>',
    ),
  ).rejects.toThrow("为空");
  await expect(
    rasterizeCadSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private/source.png" /></svg>',
    ),
  ).rejects.toThrow("外部资源");
});

it.each([
  {
    name: "毫米尺寸的宽矩形保持长宽比",
    source:
      '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="20mm" viewBox="0 0 100 20"><path d="M 10 5 H 90 V 15 H 10 Z" fill="none" stroke="black" stroke-width="0.2" /></svg>',
    ratio: 8,
  },
  {
    name: "父容器平移后的非零原点投影不被裁空或拉伸",
    source:
      '<svg xmlns="http://www.w3.org/2000/svg" width="12mm" height="22mm" viewBox="112 -245 12 22"><g fill="none" stroke="black" stroke-width="0.0285714" transform="scale(1,-1)"><path d="M113 224 H123 V244 H113 Z" /></g></svg>',
    ratio: 0.5,
  },
])("$name", async ({ source, ratio }) => {
  const bytes = await rasterizeCadSvg(source);
  const png = PNG.sync.read(bytes);
  let minX = png.width,
    maxX = 0,
    minY = png.height,
    maxY = 0;
  for (let y = 0; y < png.height; y += 1)
    for (let x = 0; x < png.width; x += 1) {
      if ((png.data[(y * png.width + x) * 4] ?? 255) >= 240) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  const measured = (maxX - minX) / (maxY - minY);
  expect(measured).toBeGreaterThan(ratio * 0.96);
  expect(measured).toBeLessThan(ratio * 1.04);
});

it("物理尺寸很大的同一投影仍只解码预览画幅，缺失投影范围时拒绝", async () => {
  const bytes = await rasterizeCadSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000000mm" height="200000mm" viewBox="0 0 100 20"><path d="M 10 5 H 90 V 15 H 10 Z" fill="none" stroke="black" stroke-width="0.2" /></svg>',
  );
  const png = PNG.sync.read(bytes);
  expect([png.width, png.height]).toEqual([1024, 768]);
  await expect(
    rasterizeCadSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10"/>',
    ),
  ).rejects.toThrow("投影范围");
});

it("预览PNG保留Task文件，模型拿到图片而canonical只保留路径元数据；已有文件不覆盖", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "kfw-cad-preview-")),
  );
  roots.push(root);
  const fixture = await createCadTestContext(root);
  const svgPath = join(root, "projection.svg");
  const outputPath = join(root, "preview.png");
  await writeFile(svgPath, svg);
  const handle = fixture.context.scopeHandle;
  if (!handle) throw new Error("缺少测试Task");
  const input = {
    handle,
    svgPath,
    outputPath,
    signal: fixture.controller.signal,
    maxSvgBytes: 64 * 1024 * 1024,
    nativeResult: {
      protocol: "kfw-cad/1" as const,
      executionId: "preview",
      success: true,
      version: ["1", "1", "4"],
      preview: {
        kind: "wireframe" as const,
        view: "isometric" as const,
        objectNames: ["Body"],
        projectedBounds: [-21.2132, 0, 7.07107, 32.6599],
      },
    },
  };
  const result = await createCadPreviewResult(input);
  expect(result.canonicalOutput).toMatchObject({
    filePath: outputPath,
    svgPath,
    width: 1024,
    height: 768,
    preview: {
      kind: "wireframe",
      projectedBounds: input.nativeResult.preview.projectedBounds,
    },
  });
  const image = result.modelContent?.find(
    (content) => content.type === "image",
  );
  if (image?.type !== "image") throw new Error("模型没有收到PNG观察");
  expect(await readFile(outputPath)).toEqual(Buffer.from(image.data, "base64"));
  expect(JSON.stringify(result.canonicalOutput)).not.toContain(image.data);
  expect(JSON.stringify(result.structuredContent)).not.toContain(image.data);
  const original = await readFile(outputPath);
  await expect(createCadPreviewResult(input)).rejects.toThrow();
  expect(await readFile(outputPath)).toEqual(original);
  await expect(
    createCadPreviewResult({ ...input, outputPath: "../escape.png" }),
  ).rejects.toThrow("授权目录");
  fixture.controller.abort();
  await expect(
    createCadPreviewResult({
      ...input,
      outputPath: join(root, "cancelled.png"),
    }),
  ).rejects.toThrow();
});
