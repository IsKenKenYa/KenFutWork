import { chmod, readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { executeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];
const point = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const pageSchema = z.object({
  objectName: z.string(),
  coordinateFrame: z.literal("global"),
  unit: z.literal("mm"),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  items: z.array(
    z.object({
      name: z.string().regex(/^Edge[1-9]\d*$/u),
      curveType: z.string().nullable(),
      length: z.number().finite().nonnegative(),
      vertices: z.array(point),
      bounds: z.array(z.number().finite()).length(6).nullable(),
      closed: z.boolean(),
    }),
  ),
});

const seedSource = [
  "container = doc.addObject('App::Part','Container')",
  "container.Placement = App.Placement(App.Vector(100,200,300),App.Rotation(App.Vector(0,0,1),90))",
  "box = doc.addObject('Part::Box','Box')",
  "container.addObject(box)",
  "box.Length,box.Width,box.Height = 4,6,8",
  "box.Placement = App.Placement(App.Vector(2,3,4),App.Rotation(App.Vector(1,0,0),90))",
  "ring = doc.addObject('Part::Feature','Ring')",
  "ring.Shape = Part.makeCircle(5,App.Vector(10,20,30))",
  "sphere = doc.addObject('Part::Feature','Sphere')",
  "sphere.Shape = Part.makeSphere(3)",
  "many = doc.addObject('Part::Feature','ManyEdges')",
  "many.Shape = Part.makeCompound([Part.makeLine(App.Vector(i*2,0,0),App.Vector(i*2+1,0,0)) for i in range(120)])",
  "doc.recompute()",
].join("\n");

async function seed(fixture: NativeCad) {
  const result = await fixture.service.execute(
    { action: "python", input: { source: seedSource } },
    { ...fixture.context, toolCallId: "topology-seed" },
  );
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const path = z
    .string()
    .parse(cadResultSchema.parse(result.structuredContent).outputPath);
  await chmod(path, 0o444);
  return path;
}

async function query(
  fixture: NativeCad,
  documentPath: string,
  edges: Record<string, unknown>,
  callId: string,
) {
  const tool = createCadTools(fixture.service).find(
    (item) => item.name === "cad_describe_document",
  );
  if (!tool) throw new Error("缺少CAD工程检查工具");
  return executeCadTestTool(
    tool,
    { documentPath, edges },
    { ...fixture.context, toolCallId: callId },
  );
}

async function page(
  fixture: NativeCad,
  documentPath: string,
  edges: Record<string, unknown>,
  callId: string,
) {
  const result = await query(fixture, documentPath, edges, callId);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent.outputPath).toBeUndefined();
  return pageSchema.parse(result.structuredContent.edgePage);
}

function expectBounds(points: number[][], bounds: number[]) {
  const actual = [0, 1, 2]
    .map((axis) => Math.min(...points.map((p) => p[axis] ?? NaN)))
    .concat(
      [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis] ?? NaN))),
    );
  for (const [index, expected] of bounds.entries())
    expect(actual[index]).toBeCloseTo(expected, 6);
}

test.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "真实边查询按当前EdgeN分页并保留全局坐标、闭合与退化拓扑，不保存源工程",
  async () =>
    withNativeCad(async (fixture) => {
      const documentPath = await seed(fixture);
      const original = await readFile(documentPath);
      const box = await page(
        fixture,
        documentPath,
        { objectName: "Box", limit: 20 },
        "edges-box",
      );
      expect(box).toMatchObject({
        objectName: "Box",
        total: 12,
        offset: 0,
        nextOffset: null,
      });
      expect(box.items.map((edge) => edge.name)).toEqual(
        Array.from({ length: 12 }, (_, i) => `Edge${i + 1}`),
      );
      expectBounds(
        box.items.flatMap((edge) => edge.vertices),
        [97, 202, 304, 105, 206, 310],
      );
      const lengths = box.items
        .map((edge) => edge.length)
        .sort((a, b) => a - b);
      for (const [index, length] of [
        4, 4, 4, 4, 6, 6, 6, 6, 8, 8, 8, 8,
      ].entries())
        expect(lengths[index]).toBeCloseTo(length, 6);
      expect(
        box.items.every(
          (edge) =>
            edge.curveType?.includes("Line") &&
            !edge.closed &&
            edge.vertices.length === 2,
        ),
      ).toBe(true);
      const ring = await page(
        fixture,
        documentPath,
        { objectName: "Ring" },
        "edges-ring",
      );
      expect(ring.items).toHaveLength(1);
      expect(ring.items[0]).toMatchObject({
        name: "Edge1",
        closed: true,
        curveType: "Circle",
      });
      expect(ring.items[0]?.vertices).toHaveLength(1);
      expect(ring.items[0]?.length).toBeCloseTo(10 * Math.PI, 6);
      const sphere = await page(
        fixture,
        documentPath,
        { objectName: "Sphere" },
        "edges-sphere",
      );
      expect(sphere.items).toHaveLength(3);
      const poles = sphere.items.filter((edge) => edge.length < 1e-9);
      expect(poles).toHaveLength(2);
      expect(poles.every((edge) => edge.curveType === null)).toBe(true);
      expect(poles.every((edge) => edge.bounds === null)).toBe(true);
      expect(await readFile(documentPath)).toEqual(original);
    }),
  90_000,
);

test.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "边分页可取完大于默认页的全部边，超尾为空，缺失或无Shape对象明确失败",
  async () =>
    withNativeCad(async (fixture) => {
      const documentPath = await seed(fixture);
      const original = await readFile(documentPath);
      const first = await page(
        fixture,
        documentPath,
        { objectName: "ManyEdges" },
        "edges-page-1",
      );
      expect(first).toMatchObject({ total: 120, offset: 0, nextOffset: 50 });
      expect(first.items).toHaveLength(50);
      const rest = await page(
        fixture,
        documentPath,
        { objectName: "ManyEdges", offset: 50, limit: 1000 },
        "edges-page-rest",
      );
      expect(rest).toMatchObject({ total: 120, offset: 50, nextOffset: null });
      expect([...first.items, ...rest.items].map((edge) => edge.name)).toEqual(
        Array.from({ length: 120 }, (_, i) => `Edge${i + 1}`),
      );
      for (const offset of [120, 121, Number.MAX_SAFE_INTEGER]) {
        const empty = await page(
          fixture,
          documentPath,
          { objectName: "ManyEdges", offset },
          `edges-tail-${offset}`,
        );
        expect(empty).toMatchObject({
          total: 120,
          offset,
          items: [],
          nextOffset: null,
        });
      }
      for (const objectName of ["Missing", "Container"]) {
        const failed = await query(
          fixture,
          documentPath,
          { objectName },
          `edges-refused-${objectName}`,
        );
        expect(failed).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "execution_failed" } },
        });
      }
      expect(await readFile(documentPath)).toEqual(original);
    }),
  90_000,
);
