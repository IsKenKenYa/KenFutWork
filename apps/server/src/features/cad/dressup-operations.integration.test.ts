import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { executeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];

async function call(
  fixture: NativeCad,
  name: string,
  args: Record<string, unknown>,
  id: string,
) {
  const tool = createCadTools(fixture.service).find(
    (item) => item.name === name,
  );
  if (!tool) throw new Error(`缺少CAD工具: ${name}`);
  const result = await executeCadTestTool(tool, args, {
    ...fixture.context,
    toolCallId: id,
  });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return cadResultSchema.parse(result.structuredContent);
}

const baseOperations = [
  { kind: "create_body", name: "Body" },
  {
    kind: "create_sketch",
    name: "Sketch",
    body: "Body",
    profiles: [{ kind: "rectangle", name: "Base", width: 10, height: 10 }],
  },
  {
    kind: "create_pad",
    name: "Pad",
    body: "Body",
    profile: "Sketch",
    length: 10,
  },
];

async function currentVerticalEdges(
  fixture: NativeCad,
  path: string,
  id: string,
) {
  const described = await call(
    fixture,
    "cad_describe_document",
    { documentPath: path, edges: { objectName: "Pad" } },
    id,
  );
  const edges = described.edgePage?.items;
  if (!edges) throw new Error("缺少当前拓扑边");
  return [0, 10].map((coordinate) => {
    const candidates = edges.filter(
      (edge) =>
        edge.vertices.length === 2 &&
        edge.vertices.every(
          (point) =>
            Math.abs(point[0] - coordinate) < 1e-7 &&
            Math.abs(point[1] - coordinate) < 1e-7,
        ),
    );
    expect(candidates).toHaveLength(1);
    return candidates[0]?.name ?? "";
  });
}

function volume(dimension: string, length: number, size: number) {
  return (
    100 * length -
    2 * (dimension === "radius" ? 1 - Math.PI / 4 : 0.5) * size * size * length
  );
}

const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";

const modes = [
  {
    kind: "create_fillet",
    dimension: "radius",
    parameter: "Radius",
    type: "PartDesign::Fillet",
  },
  {
    kind: "create_chamfer",
    dimension: "size",
    parameter: "Size",
    type: "PartDesign::Chamfer",
  },
] as const;

test.skipIf(nativeUnavailable).each(modes)(
  "结构化$kind从真实选边到多边创建、改尺寸和重开保留参数链",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        { operations: baseOperations },
        `${mode.dimension}-base`,
      );
      const source = z.string().parse(seed.outputPath);
      const original = await readFile(source);
      const edges = await currentVerticalEdges(
        fixture,
        source,
        `${mode.dimension}-edges`,
      );
      const created = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: source,
          operations: [
            {
              kind: mode.kind,
              name: "Dressed",
              body: "Body",
              base: "Pad",
              edges,
              [mode.dimension]: 1,
            },
          ],
        },
        `${mode.dimension}-create`,
      );
      const path = z.string().parse(created.outputPath);
      const bytes = await readFile(path);
      const first = created.document?.objects.find(
        (obj) => obj.name === "Dressed",
      );
      expect(first?.shape).toMatchObject({ valid: true, solids: 1 });
      expect(first?.shape?.volume).toBeCloseTo(
        volume(mode.dimension, 10, 1),
        6,
      );
      const edited = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: path,
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 12,
            },
            {
              kind: "set_dimension",
              object: "Dressed",
              dimension: mode.dimension,
              value: 2,
            },
          ],
        },
        `${mode.dimension}-edit`,
      );
      const editedPath = z.string().parse(edited.outputPath);
      const result = edited.document?.objects.find(
        (obj) => obj.name === "Dressed",
      );
      expect(result?.shape?.volume).toBeCloseTo(
        volume(mode.dimension, 12, 2),
        6,
      );
      const inspected = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: editedPath,
          source: [
            "body,feature,base = doc.getObject('Body'),doc.getObject('Dressed'),doc.getObject('Pad')",
            `assert feature.TypeId == ${JSON.stringify(mode.type)}`,
            "assert feature.BaseFeature is base and feature.Base[0] is base and len(feature.Base[1]) == 2",
            "assert body.Tip is feature and not feature.UseAllEdges",
            `assert abs(feature.${mode.parameter}.Value - 2) < 1e-7 and abs(base.Length.Value - 12) < 1e-7`,
            "assert not base.ViewObject.Visibility and feature.ViewObject.Visibility",
            ...(mode.dimension === "size"
              ? ["assert feature.ChamferType == 'Equal distance'"]
              : []),
            `assert abs(body.Shape.Volume - ${volume(mode.dimension, 12, 2)}) < 1e-6`,
            "result = {'parameterLinks':True}",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-readback`,
      );
      expect(inspected.data).toEqual({ parameterLinks: true });
      expect(await readFile(source)).toEqual(original);
      expect(await readFile(path)).toEqual(bytes);
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "原生零参数外置probe区分锐边与平滑边，混合选择不能仅凭有效Shape宣称全处理",
  async () =>
    withNativeCad(async (fixture) => {
      const tool = createCadTools(fixture.service).find(
        (item) => item.name === "cad_run_python",
      );
      if (!tool) throw new Error("缺少CAD Python工具");
      const source = await readFile(
        new URL("./fixtures/dressup-selection.py", import.meta.url),
        "utf8",
      );
      const result = await executeCadTestTool(
        tool,
        { source, requireSolids: true },
        fixture.context,
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const data = z
        .object({
          outcomes: z.array(
            z.object({
              kind: z.enum(["Fillet", "Chamfer"]),
              edgeClass: z.enum(["sharp", "smooth"]),
              status: z.string(),
              parameter: z.number(),
              shapeNull: z.boolean(),
              outsideBody: z.boolean(),
            }),
          ),
          mixedVolume: z.number(),
          mixedRequestedEdges: z.array(z.string()),
          tip: z.string(),
        })
        .parse(result.structuredContent.data);
      expect(data.outcomes).toEqual([
        {
          kind: "Fillet",
          edgeClass: "sharp",
          status: "Fillet radius must be greater than zero",
          parameter: 0,
          shapeNull: true,
          outsideBody: true,
        },
        {
          kind: "Fillet",
          edgeClass: "smooth",
          status: "Fillet not possible on selected shapes",
          parameter: 0,
          shapeNull: true,
          outsideBody: true,
        },
        {
          kind: "Chamfer",
          edgeClass: "sharp",
          status: "Size must be greater than zero",
          parameter: 0,
          shapeNull: true,
          outsideBody: true,
        },
        {
          kind: "Chamfer",
          edgeClass: "smooth",
          status: "No edges specified",
          parameter: 0,
          shapeNull: true,
          outsideBody: true,
        },
      ]);
      expect(data.mixedRequestedEdges).toHaveLength(2);
      expect(data.mixedVolume).toBeCloseTo(
        1000 - (1 - Math.PI / 4) * 10 * (1 + 0.25),
        6,
      );
      expect(data.tip).toBe("MixedFillet");
    }),
  60_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind同批建模与已有哈希工程编辑均保持保存后的原生参数链",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        { operations: baseOperations },
        "batch-seed",
      );
      const seedPath = z.string().parse(seed.outputPath);
      const edges = await currentVerticalEdges(
        fixture,
        seedPath,
        "batch-edges",
      );
      const batch = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...baseOperations,
            {
              kind: mode.kind,
              name: "Dressed",
              body: "Body",
              base: "Pad",
              edges,
              [mode.dimension]: 1,
            },
          ],
        },
        "single-batch",
      );
      const batchEdited = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: z.string().parse(batch.outputPath),
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 12,
            },
          ],
        },
        "batch-reopened",
      );
      expect(
        batchEdited.document?.objects.find((obj) => obj.name === "Dressed")
          ?.shape?.volume,
      ).toBeCloseTo(volume(mode.dimension, 12, 1), 6);
      const hashed = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seedPath,
          source: [
            "assert doc.UseHasher",
            `feature = doc.getObject('Body').newObject(${JSON.stringify(mode.type)},'Dressed')`,
            `feature.Base = (doc.getObject('Pad'), ${JSON.stringify(edges)})`,
            `feature.${mode.parameter} = 1`,
            "doc.recompute()",
            "assert feature.getStatusString() == 'Valid'",
          ].join("\n"),
        },
        "native-hashed",
      );
      const converted = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: z.string().parse(hashed.outputPath),
          operations: [
            {
              kind: "set_dimension",
              object: "Dressed",
              dimension: mode.dimension,
              value: 2,
            },
          ],
        },
        "edit-native-hashed",
      );
      const final = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: z.string().parse(converted.outputPath),
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 12,
            },
          ],
        },
        "native-converted-reopened",
      );
      expect(
        final.document?.objects.find((obj) => obj.name === "Dressed")?.shape
          ?.volume,
      ).toBeCloseTo(volume(mode.dimension, 12, 2), 6);
    }),
  90_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind原位编辑早期修饰特征保留后继Tip、原生引用和显示状态",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        { operations: baseOperations },
        "chain-seed",
      );
      const seedPath = z.string().parse(seed.outputPath);
      const edges = await currentVerticalEdges(
        fixture,
        seedPath,
        "chain-edges",
      );
      const first = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: seedPath,
          operations: [
            {
              kind: mode.kind,
              name: "Dressed",
              body: "Body",
              base: "Pad",
              edges,
              [mode.dimension]: 1,
            },
          ],
        },
        "chain-first",
      );
      const described = await call(
        fixture,
        "cad_describe_document",
        {
          documentPath: first.outputPath,
          edges: { objectName: "Dressed" },
        },
        "chain-next-edge",
      );
      const next = described.edgePage?.items.filter(
        (edge) =>
          edge.vertices.length === 2 &&
          edge.vertices.every(
            (point) =>
              Math.abs(point[0] - 10) < 1e-7 && Math.abs(point[1]) < 1e-7,
          ),
      );
      expect(next).toHaveLength(1);
      const last = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: first.outputPath,
          operations: [
            {
              kind:
                mode.kind === "create_fillet"
                  ? "create_chamfer"
                  : "create_fillet",
              name: "Last",
              body: "Body",
              base: "Dressed",
              edges: [next?.[0]?.name],
              [mode.dimension === "radius" ? "size" : "radius"]: 0.3,
            },
          ],
        },
        "chain-last",
      );
      const changed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: last.outputPath,
          operations: [
            {
              kind: "set_dimension",
              object: "Dressed",
              dimension: mode.dimension,
              value: 2,
            },
          ],
        },
        "chain-edit",
      );
      const expected =
        volume(mode.dimension, 10, 2) -
        (mode.dimension === "radius" ? 0.5 : 1 - Math.PI / 4) * 0.3 * 0.3 * 10;
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: changed.outputPath,
          source: [
            "body,first,last = doc.getObject('Body'),doc.getObject('Dressed'),doc.getObject('Last')",
            "assert body.Tip is last and last.BaseFeature is first and last.Base[0] is first",
            "assert first.BaseFeature is doc.getObject('Pad')",
            "assert not first.ViewObject.Visibility and last.ViewObject.Visibility",
            `assert abs(body.Shape.Volume - ${expected}) < 1e-6`,
            "assert first.getStatusString() == last.getStatusString() == 'Valid'",
            "assert not doc.UseHasher",
          ].join("\n"),
        },
        "chain-readback",
      );
    }),
  90_000,
);
