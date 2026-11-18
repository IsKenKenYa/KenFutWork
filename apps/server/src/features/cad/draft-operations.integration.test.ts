import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { invokeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";
type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];

const point = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const edge = z
  .object({
    start: point,
    end: point,
    length: z.number().positive(),
    curveType: z.literal("Part::GeomLine"),
  })
  .passthrough();
const snapshot = z.object({
  parameters: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    closed: z.literal(true),
    makeFace: z.literal(true),
  }),
  placement: z.object({
    position: point,
    quaternion: z.array(z.number().finite()).length(4),
  }),
  points: z.object({
    local: z.array(point).length(4),
    global: z.array(point).length(4),
  }),
  geometry: z.object({
    valid: z.literal(true),
    closed: z.literal(true),
    planar: z.literal(true),
    edgeCount: z.literal(4),
    vertexCount: z.literal(4),
    faceCount: z.literal(1),
    wireCount: z.literal(1),
    solidCount: z.literal(0),
    normal: point,
    area: z.number().positive(),
    perimeter: z.number().positive(),
    localBounds: z.array(z.number()).length(6),
    globalBounds: z.array(z.number()).length(6),
    localVertices: z.array(point).length(4),
    globalVertices: z.array(point).length(4),
    localEdges: z.array(edge).length(4),
    globalEdges: z.array(edge).length(4),
  }),
});
const dataSchema = z.object({
  capability: z.literal("draft_wire"),
  reused: z.boolean(),
  objectName: z.literal("Wire"),
  nativeTypeId: z.literal("Part::FeaturePython"),
  proxyType: z.literal("draftobjects.wire.Wire"),
  viewProviderType: z.literal("draftviewproviders.view_wire.ViewProviderWire"),
  incoming: snapshot,
  stages: z.array(snapshot).length(2),
});

function rectangle(
  width: number,
  height: number,
  world: boolean,
): [number, number, number][] {
  const local: [number, number, number][] = [
    [0, 0, 0],
    [width, 0, 0],
    [width, height, 0],
    [0, height, 0],
  ];
  return world
    ? local.map(([x, y, z]) => [
        125 + (x * Math.sqrt(3)) / 2 - y / 2,
        -75 + x / 2 + (y * Math.sqrt(3)) / 2,
        z,
      ])
    : local;
}
function near(actual: number, expected: number, tolerance = 1e-6) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}
function pointNear(actual: number[], expected: number[]) {
  for (const axis of [0, 1, 2] as const)
    near(actual[axis] ?? NaN, expected[axis] ?? NaN);
}
function checkVertices(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(4);
  for (const target of expected)
    expect(
      actual.filter((candidate) =>
        candidate.every(
          (value, axis) => Math.abs(value - (target[axis] ?? NaN)) <= 1e-6,
        ),
      ),
    ).toHaveLength(1);
}
function checkEdges(actual: z.infer<typeof edge>[], expected: number[][]) {
  expect(actual).toHaveLength(4);
  const matches = new Set<number>();
  for (const item of actual) {
    const found = expected
      .map((start, index) => ({
        start,
        end: expected[(index + 1) % 4] ?? [],
        index,
      }))
      .filter(({ start, end }) =>
        [
          [item.start, item.end],
          [item.end, item.start],
        ].some(
          ([a, b]) =>
            a?.every((v, i) => Math.abs(v - (start[i] ?? NaN)) <= 1e-6) &&
            b?.every((v, i) => Math.abs(v - (end[i] ?? NaN)) <= 1e-6),
        ),
      );
    expect(found).toHaveLength(1);
    const target = found[0];
    if (!target) throw new Error("交换文件缺少预期边");
    expect(matches.has(target.index)).toBe(false);
    matches.add(target.index);
    near(
      item.length,
      Math.hypot(...target.start.map((v, i) => v - (target.end[i] ?? NaN))),
      2e-6,
    );
  }
}
function checkSnapshot(
  raw: z.infer<typeof snapshot>,
  width: number,
  height: number,
) {
  near(raw.parameters.width, width);
  near(raw.parameters.height, height);
  pointNear(raw.placement.position, [125, -75, 0]);
  raw.placement.quaternion.forEach((value, index) => {
    near(
      value,
      [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)][index] ?? NaN,
    );
  });
  pointNear(raw.geometry.normal, [0, 0, 1]);
  near(raw.geometry.area, width * height, 1e-5);
  near(raw.geometry.perimeter, 2 * (width + height));
  const local = rectangle(width, height, false),
    world = rectangle(width, height, true);
  for (const [index, value] of raw.points.local.entries())
    pointNear(value, local[index] ?? []);
  for (const [index, value] of raw.points.global.entries())
    pointNear(value, world[index] ?? []);
  checkVertices(raw.geometry.localVertices, local);
  checkVertices(raw.geometry.globalVertices, world);
  checkEdges(raw.geometry.localEdges, local);
  checkEdges(raw.geometry.globalEdges, world);
  const bounds = [
    125 - height / 2,
    -75,
    0,
    125 + (width * Math.sqrt(3)) / 2,
    -75 + width / 2 + (height * Math.sqrt(3)) / 2,
    0,
  ];
  raw.geometry.globalBounds.forEach((value, index) => {
    near(value, bounds[index] ?? NaN);
  });
  raw.geometry.localBounds.forEach((value, index) => {
    near(value, [0, 0, 0, width, height, 0][index] ?? NaN);
  });
}

async function draftSource(options: Record<string, unknown>) {
  const fixture = await readFile(
    new URL("./fixtures/draft-wire.py", import.meta.url),
    "utf8",
  );
  return `import json\n${fixture}\nresult=run_wire_case(json.loads(${JSON.stringify(JSON.stringify(options))}))`;
}

const exchangeSchema = z.object({
  kind: z.enum(["svg", "dxf"]),
  path: z.string(),
  sourceSha256: z.string(),
  importer: z.object({ name: z.string() }).passthrough(),
  units: z.object({ coordinateUnit: z.literal("mm") }).passthrough(),
  geometry: z.object({
    edgeCount: z.literal(4),
    wireCount: z.literal(1),
    closed: z.literal(true),
    valid: z.literal(true),
    planar: z.literal(true),
    bounds: z.array(z.number().finite()).length(6),
    vertices: z.array(point).length(4),
    edges: z.array(edge).length(4),
    perimeter: z.number().positive(),
    enclosedArea: z.number().positive(),
    importedFaceCount: z.number().int().nonnegative(),
  }),
});

async function checkExchange(
  fixture: NativeCad,
  path: string,
  format: "svg" | "dxf",
  width: number,
  height: number,
  id: string,
  seen: Map<string, string>,
) {
  const inputBytes = await readFile(path);
  const exported = await invokeCadTestTool(
    fixture,
    "cad_export",
    { documentPath: path, objectNames: ["Wire"], format, view: "top" },
    `draft-export-${id}-${format}`,
  );
  expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
  const result = cadResultSchema.parse(exported.structuredContent);
  const file = z.string().parse(result.outputPath),
    bytes = await readFile(file);
  expect(seen.has(file)).toBe(false);
  const hash = createHash("sha256").update(bytes).digest("hex");
  seen.set(file, hash);
  if (format === "dxf")
    expect(bytes.toString("utf8")).toMatch(/\$INSUNITS\s+70\s+4(?:\s|$)/u);
  const helper = await readFile(
    new URL("./fixtures/draft-exchange.py", import.meta.url),
    "utf8",
  );
  const imported = await invokeCadTestTool(
    fixture,
    "cad_run_python",
    {
      source: `${helper}\nresult=read_draft_exchange(${JSON.stringify(file)},${JSON.stringify(format)})`,
      requireSolids: false,
    },
    `draft-readback-${id}-${format}`,
  );
  expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
  const readback = exchangeSchema.parse(
    cadResultSchema.parse(imported.structuredContent).data,
  );
  expect(readback.sourceSha256).toBe(hash);
  expect(readback.path).toBe(file);
  expect(readback.kind).toBe(format);
  expect(readback.importer.name).toBe(
    format === "svg" ? "importSVG.insert" : "Import.readDXF",
  );
  const expected = rectangle(width, height, true),
    geometry = readback.geometry;
  checkVertices(geometry.vertices, expected);
  checkEdges(geometry.edges, expected);
  const bounds = [
    125 - height / 2,
    -75,
    0,
    125 + (width * Math.sqrt(3)) / 2,
    -75 + width / 2 + (height * Math.sqrt(3)) / 2,
    0,
  ];
  geometry.bounds.forEach((value, index) => {
    near(value, bounds[index] ?? NaN);
  });
  near(geometry.perimeter, 2 * (width + height), 8e-6);
  // 文本坐标的每轴1e-6mm误差传播到围面积，阈值按真实周长计算。
  near(geometry.enclosedArea, width * height, 2e-6 * 2 * (width + height));
  expect(await readFile(file)).toEqual(bytes);
  expect(await readFile(path)).toEqual(inputBytes);
}

test.skipIf(nativeUnavailable)(
  "Draft真实闭合参数面改点后保存重开，局部与全局几何及源工程保持",
  async () =>
    withNativeCad(async (fixture) => {
      let path: string | undefined;
      const seen = new Map<string, string>();
      for (const [index, [width, height, resizedWidth, resizedHeight]] of (
        [
          [1000, 500, 1250, 600],
          [1250, 600, 1500, 750],
          [1500, 750, 1000, 500],
        ] as const
      ).entries()) {
        const bytes = path ? await readFile(path) : undefined;
        const authored = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            ...(path ? { documentPath: path } : {}),
            source: await draftSource({
              width,
              height,
              resizedWidth,
              resizedHeight,
            }),
            requireSolids: false,
          },
          `draft-wire-round-${index}`,
        );
        expect(authored.isError, JSON.stringify(authored)).not.toBe(true);
        const checked = cadResultSchema.parse(authored.structuredContent);
        const data = dataSchema.parse(checked.data);
        expect(data.reused).toBe(index > 0);
        checkSnapshot(data.incoming, width, height);
        const first = data.stages[0],
          last = data.stages[1];
        if (!first || !last) throw new Error("Draft阶段数据缺失");
        checkSnapshot(first, width, height);
        checkSnapshot(last, resizedWidth, resizedHeight);
        expect(checked.data).toMatchObject({
          capability: "draft_wire",
          reused: index > 0,
          objectName: "Wire",
          parameters: {
            width: resizedWidth,
            height: resizedHeight,
            closed: true,
            makeFace: true,
          },
        });
        const shape = checked.document?.objects.find(
          (obj) => obj.name === "Wire",
        )?.shape;
        expect(shape).toMatchObject({
          valid: true,
          solids: 0,
          faces: 1,
          edges: 4,
        });
        expect(shape?.area).toBeCloseTo(resizedWidth * resizedHeight, 5);
        if (path) expect(await readFile(path)).toEqual(bytes);
        path = z.string().parse(checked.outputPath);
        for (const format of ["dxf", "svg"] as const)
          await checkExchange(
            fixture,
            path,
            format,
            resizedWidth,
            resizedHeight,
            String(index),
            seen,
          );
      }
      expect(seen.size).toBe(6);
      for (const [file, hash] of seen)
        expect(
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ).toBe(hash);
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "Draft自交面与要求三维实体均拒绝，失败不发布也不改源工程",
  async () =>
    withNativeCad(async (fixture) => {
      const authored = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        { source: await draftSource({}), requireSolids: false },
        "draft-negative-source",
      );
      expect(authored.isError, JSON.stringify(authored)).not.toBe(true);
      const path = z
        .string()
        .parse(cadResultSchema.parse(authored.structuredContent).outputPath);
      const before = await readFile(path);
      for (const [index, input] of [
        {
          source: "pass",
          requireSolids: true,
        },
        {
          source:
            "doc.getObject('Wire').Points = [App.Vector(0,0,0), App.Vector(100,100,0), App.Vector(0,100,0), App.Vector(100,0,0)]\ndoc.recompute()",
          requireSolids: false,
        },
      ].entries()) {
        const outputPath = join(fixture.root, `draft-invalid-${index}.FCStd`);
        const failed = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          { documentPath: path, outputPath, ...input },
          `draft-negative-${index}`,
        );
        expect(failed.isError, JSON.stringify(failed)).toBe(true);
        expect(failed.structuredContent).toMatchObject({
          error: { code: "execution_failed" },
        });
        const failure = z
          .object({ error: z.object({ message: z.string() }) })
          .parse(failed.structuredContent);
        expect(failure.error.message).toMatch(
          index === 0
            ? /工程没有有效实体/u
            : /对象(?:几何为空或无效|重算失败): Wire/u,
        );
        await expect(readFile(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(path)).toEqual(before);
      }
    }),
  90_000,
);
