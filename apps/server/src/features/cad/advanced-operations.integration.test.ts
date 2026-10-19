import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

const nativeUnavailable =
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
  process.platform !== "darwin";

const stageSchema = z.enum([
  "initial",
  "initial_reopened",
  "edited",
  "edited_reopened",
]);
const capabilitySchema = z.enum([
  "boolean_fuse",
  "boolean_cut",
  "boolean_common",
  "fillet",
  "chamfer",
  "linear_pattern",
  "polar_pattern",
  "techdraw_projection_dimensions_svg",
]);
const fixtureDataSchema = z.object({
  suite: z.literal("advanced_official_operations"),
  checkpoints: z.array(z.string().min(1)).length(2),
  checks: z.array(
    z
      .object({ stage: stageSchema, capability: capabilitySchema })
      .passthrough(),
  ),
  artifacts: z.array(
    z.object({ path: z.string().min(1), bytes: z.number().positive() }),
  ),
});

function svgAttribute(tag: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "u").exec(tag);
  if (!match?.[2]) throw new Error(`SVG 缺少属性：${name}`);
  return match[2];
}

function millimeters(value: string): number {
  const match = /^(\d+(?:\.\d+)?)mm$/u.exec(value);
  if (!match?.[1]) throw new Error(`SVG 页面尺寸没有使用 mm：${value}`);
  return Number(match[1]);
}

function svgTextLabels(svg: string): string[] {
  return Array.from(
    svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text\s*>/giu),
    (match) => (match[1] ?? "").replace(/<[^>]*>/gu, "").trim(),
  );
}

async function checkDimensionedPage(
  path: string,
  width: number,
  height: number,
) {
  const svg = await readFile(path, "utf8");
  const root = /<svg\b[^>]*>/u.exec(svg)?.[0];
  if (!root) throw new Error(`输出缺少 SVG 根元素：${path}`);
  expect(millimeters(svgAttribute(root, "width"))).toBeCloseTo(297, 6);
  expect(millimeters(svgAttribute(root, "height"))).toBeCloseTo(210, 6);
  const viewBox = svgAttribute(root, "viewBox")
    .trim()
    .split(/\s+/u)
    .map(Number);
  expect(viewBox).toHaveLength(4);
  expect(viewBox.every(Number.isFinite)).toBe(true);
  expect(viewBox.slice(0, 2)).toEqual([0, 0]);
  const canvasWidth = z.number().positive().parse(viewBox[2]);
  const canvasHeight = z.number().positive().parse(viewBox[3]);
  expect(canvasWidth / canvasHeight).toBeCloseTo(297 / 210, 9);

  // 只匹配实际 text 元素，避免把元数据、viewBox 或路径坐标当作尺寸文字。
  const labels = svgTextLabels(svg);
  for (const expected of [width, height]) {
    const pattern = new RegExp(`^${expected}(?:[.,]0+)?(?:\\s*mm)?$`, "u");
    expect(
      labels.some((label) => pattern.test(label)),
      JSON.stringify({ path, expected, labels }),
    ).toBe(true);
  }
  expect(svg).toMatch(/<(?:path|line|polyline|polygon|circle)\b/u);
}

async function checkAuthoredArtifacts(rawData: unknown) {
  const data = fixtureDataSchema.parse(rawData);
  expect(data.checks).toHaveLength(32);
  for (const stage of stageSchema.options) {
    expect(
      data.checks
        .filter((check) => check.stage === stage)
        .map((check) => check.capability)
        .sort(),
    ).toEqual([...capabilitySchema.options].sort());
    const pageName = `advanced-${stage}-dimensioned-page.svg`;
    const page = data.artifacts.find(
      (artifact) => basename(artifact.path) === pageName,
    );
    if (!page) throw new Error(`缺少阶段工程图：${stage}`);
    await checkDimensionedPage(
      page.path,
      stage.startsWith("initial") ? 40 : 50,
      stage.startsWith("initial") ? 20 : 25,
    );
    const projection = data.artifacts.find(
      (artifact) =>
        basename(artifact.path) === `advanced-${stage}-projection.svg`,
    );
    if (!projection) throw new Error(`缺少阶段原生投影：${stage}`);
    expect(await readFile(projection.path, "utf8")).toMatch(
      /<(?:path|line|polyline|polygon|circle)\b/u,
    );
  }
  for (const path of data.checkpoints)
    expect((await stat(path)).size).toBeGreaterThan(0);
}

function checkIndependentGeometry(
  document: NonNullable<z.output<typeof cadResultSchema>["document"]>,
) {
  const objects = new Map(
    document.objects.map((object) => [object.name, object]),
  );
  const expectedVolumes: Record<string, number> = {
    BooleanFuse: 1600,
    BooleanCut: 400,
    BooleanCommon: 600,
    FilletFeature: 1728 - (1 - Math.PI / 4) * 4 * 12,
    ChamferFeature: 1704,
    LinearPattern: 6240,
    PolarPattern: 5760,
    DrawingSourceBox: 15000,
  };
  for (const [name, volume] of Object.entries(expectedVolumes)) {
    const shape = objects.get(name)?.shape;
    if (!shape) throw new Error(`独立进程缺少几何：${name}`);
    expect(shape, name).toMatchObject({
      valid: true,
      null: false,
      solids: 1,
    });
    expect(Math.abs(shape.volume - volume), name).toBeLessThanOrEqual(1e-6);
  }
}

it.skipIf(nativeUnavailable)(
  "官方布尔、圆角倒角、阵列与工程图保存重开并保留参数链和真实尺寸",
  async () =>
    withNativeCad(async (fixture) => {
      const source = await readFile(
        new URL("./fixtures/advanced-operations.py", import.meta.url),
        "utf8",
      );
      const authored = await fixture.service.execute(
        {
          action: "python",
          input: {
            source,
            requireSolids: true,
            outputPath: join(fixture.root, "advanced-operations.FCStd"),
          },
        },
        { ...fixture.context, toolCallId: "advanced-official-authoring" },
      );
      expect(authored.isError, JSON.stringify(authored)).not.toBe(true);
      const model = cadResultSchema.parse(authored.structuredContent);
      const documentPath = z.string().min(1).parse(model.outputPath);
      await checkAuthoredArtifacts(model.data);
      // 每次 service 调用派发独立 FreeCAD 进程，不复用首轮 Python 对象或 result。
      const before = await readFile(documentPath);
      const described = await fixture.service.execute(
        { action: "describe", input: { documentPath } },
        { ...fixture.context, toolCallId: "advanced-independent-describe" },
      );
      expect(described.isError, JSON.stringify(described)).not.toBe(true);
      const readback = cadResultSchema.parse(described.structuredContent);
      if (!readback.document) throw new Error("独立进程没有返回工程描述");
      checkIndependentGeometry(readback.document);
      expect(await readFile(documentPath)).toEqual(before);
    }),
  120_000,
);
