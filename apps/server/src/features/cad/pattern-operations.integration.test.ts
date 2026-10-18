import { readFile, stat } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  createCadPadTestOperations,
  invokeCadTestTool,
  withNativeCad,
} from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];
const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";
const modes = [
  {
    kind: "create_linear_pattern",
    type: "PartDesign::LinearPattern",
    dimension: "length",
    parameter: "Length",
    vector: "direction",
    property: "Direction",
    axis: "H_Axis",
    extent: 30,
  },
  {
    kind: "create_polar_pattern",
    type: "PartDesign::PolarPattern",
    dimension: "angle",
    parameter: "Angle",
    vector: "axis",
    property: "Axis",
    axis: "N_Axis",
    extent: 360,
  },
] as const;

async function call(
  fixture: NativeCad,
  name: string,
  args: Record<string, unknown>,
  id: string,
) {
  const result = await invokeCadTestTool(fixture, name, args, id);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return cadResultSchema.parse(result.structuredContent);
}

const baseOperations = createCadPadTestOperations();

test.skipIf(nativeUnavailable).each(modes)(
  "$kind真实创建、修改参数和上游尺寸并重开保留全部实例与引用",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const created = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...baseOperations,
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: mode.extent,
              occurrences: 4,
            },
          ],
        },
        `${mode.dimension}-pattern-create`,
      );
      const source = z.string().parse(created.outputPath);
      const before = await readFile(source);
      expect(
        created.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(2000, 6);
      const extent = mode.dimension === "length" ? 21 : 360;
      const edited = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: source,
          operations: [
            {
              kind: "set_pattern_parameters",
              object: "Pattern",
              [mode.dimension]: extent,
              occurrences: mode.dimension === "length" ? 5 : 4,
              reversed: true,
            },
            {
              kind: "set_dimension",
              object: "Sketch",
              profile: "Base",
              dimension: "width",
              value: 12,
            },
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 6,
            },
          ],
        },
        `${mode.dimension}-pattern-edit`,
      );
      const expected = mode.dimension === "length" ? 1980 : 2880;
      expect(
        edited.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(expected, 6);
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: edited.outputPath,
          source: [
            "body,feature,pad,sketch=[doc.getObject(name) for name in ('Body','Pattern','Pad','Sketch')]",
            `assert feature.TypeId == ${JSON.stringify(mode.type)}`,
            "assert feature.BaseFeature is pad and list(feature.Originals) == [pad] and body.Tip is feature",
            `assert feature.${mode.property}[0] is sketch and list(feature.${mode.property}[1]) == [${JSON.stringify(mode.axis)}]`,
            `assert feature.Occurrences == ${mode.dimension === "length" ? 5 : 4} and feature.Reversed`,
            `assert abs(feature.${mode.parameter}.Value - ${extent}) < 1e-7`,
            "assert feature.TransformMode == 'Features' and feature.Mode == 'Extent'",
            "assert not pad.ViewObject.Visibility and feature.ViewObject.Visibility",
            `assert abs(body.Shape.Volume - ${expected}) < 1e-6`,
            "result={'linksPreserved':True}",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-pattern-readback`,
      );
      const single = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: edited.outputPath,
          operations: [
            {
              kind: "set_pattern_parameters",
              object: "Pattern",
              occurrences: 1,
            },
          ],
        },
        `${mode.dimension}-pattern-single`,
      );
      expect(
        single.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(720, 6);
      expect(await readFile(source)).toEqual(before);
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "原生单实体开关可截掉断开副本却保留Valid，不能据此宣称全部完成",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        { operations: baseOperations },
        "partial-pattern-base",
      );
      const result = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "body,pad,sketch=[doc.getObject(name) for name in ('Body','Pad','Sketch')]",
            "body.AllowCompound=False",
            "pattern=body.newObject('PartDesign::LinearPattern','Pattern')",
            "pattern.Originals=[pad]",
            "pattern.Direction=(sketch,['H_Axis'])",
            "pattern.Length=60",
            "pattern.Occurrences=4",
            "doc.recompute()",
            "status,state,valid=pattern.getStatusString(),list(pattern.State),pattern.Shape.isValid()",

            "copies=[]",
            "for offset in (20,40,60):",
            "    shape=pad.Shape.copy()",
            "    shape.translate(App.Vector(offset,0,0))",
            "    copies.append(shape)",
            "complete=pad.Shape.fuse(tuple(copies))",
            "assert complete.isValid() and len(complete.Solids)==4 and abs(complete.Volume-2000)<1e-6",
            "result={'status':status,'state':state,'valid':valid,'allowCompound':bool(body.AllowCompound),'actualSolids':len(pattern.Shape.Solids),'fullSolids':len(complete.Solids),'volume':pattern.Shape.Volume}",
            "App.closeDocument(doc.Name)",
            "doc=App.newDocument('Diagnostic')",
            "doc.addObject('Part::Box','DiagnosticBox')",
          ].join("\n"),
          requireSolids: true,
        },
        "partial-pattern-native",
      );
      expect(result.data).toEqual({
        status: "Valid",
        state: ["Up-to-date"],
        valid: true,
        allowCompound: false,
        actualSolids: 1,
        fullSolids: 4,
        volume: expect.closeTo(500, 6),
      });
    }),
  60_000,
);

test.skipIf(nativeUnavailable)(
  "允许多实体的阵列保留全部四个零件和STEP，单实体工程拒绝截断发布",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        { operations: baseOperations },
        "compound-seed",
      );
      const operation = {
        kind: "create_linear_pattern",
        name: "Pattern",
        body: "Body",
        original: "Pad",
        direction: { sketch: "Sketch", axis: "H_Axis" },
        length: 60,
        occurrences: 4,
      };
      const complete = await call(
        fixture,
        "cad_apply_operations",
        { documentPath: seed.outputPath, operations: [operation] },
        "compound-pattern",
      );
      expect(
        complete.document?.objects.find((obj) => obj.name === "Pattern")?.shape,
      ).toMatchObject({
        valid: true,
        solids: 4,
        volume: expect.closeTo(2000, 6),
      });
      const exported = await call(
        fixture,
        "cad_export",
        {
          documentPath: complete.outputPath,
          objectNames: ["Body"],
          format: "step",
        },
        "compound-step",
      );
      const readback = await call(
        fixture,
        "cad_run_python",
        {
          source: [
            "shape=Part.Shape()",
            `shape.read(${JSON.stringify(exported.outputPath)})`,
            "doc.addObject('Part::Feature','Roundtrip').Shape=shape",
            "assert shape.isValid() and len(shape.Solids)==4 and abs(shape.Volume-2000)<1e-6",
            "result={'solids':len(shape.Solids),'bounds':[shape.BoundBox.XMin,shape.BoundBox.XMax]}",
          ].join("\n"),
          requireSolids: true,
        },
        "compound-step-readback",
      );
      expect(readback.data).toEqual({
        solids: 4,
        bounds: [expect.closeTo(0, 6), expect.closeTo(70, 6)],
      });
      const single = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: "doc.getObject('Body').AllowCompound=False\ndoc.recompute()",
        },
        "single-solid-source",
      );
      const path = z.string().parse(single.outputPath);
      const original = await readFile(path);
      const outputPath = `${fixture.root}/refused-partial.FCStd`;
      const refused = await invokeCadTestTool(
        fixture,
        "cad_apply_operations",
        { documentPath: path, outputPath, operations: [operation] },
        "single-solid-refused",
      );
      expect(refused.isError, JSON.stringify(refused)).toBe(true);
      expect(refused.structuredContent).toMatchObject({
        error: { code: "execution_failed" },
      });
      const { stat } = await import("node:fs/promises");
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path)).toEqual(original);
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "阵列可重复当前支撑链中更早的Pad，同时保留后加特征只在原位出现",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        { operations: baseOperations },
        "earlier-original-seed",
      );
      const supported = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "body=doc.getObject('Body')",
            "extra=body.newObject('PartDesign::AdditiveBox','Extra')",
            "extra.Length,extra.Width,extra.Height=4,5,2",
            "extra.Placement.Base=App.Vector(2,2,5)",
            "doc.recompute()",
            "assert extra.BaseFeature is doc.getObject('Pad') and abs(body.Shape.Volume-540)<1e-6",
          ].join("\n"),
          requireSolids: true,
        },
        "earlier-original-support",
      );
      const created = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: supported.outputPath,
          operations: [
            {
              kind: "create_linear_pattern",
              name: "Pattern",
              body: "Body",
              original: "Pad",
              direction: { sketch: "Sketch", axis: "H_Axis" },
              length: 30,
              occurrences: 4,
            },
          ],
        },
        "earlier-original-pattern",
      );
      expect(
        created.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(2040, 6);
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: created.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            "assert feature.BaseFeature is doc.getObject('Extra') and list(feature.Originals)==[doc.getObject('Pad')]",
            "assert feature.Shape.isInside(App.Vector(3,3,6),1e-7,True)",
            "assert not feature.Shape.isInside(App.Vector(13,3,6),1e-7,True)",
            "assert doc.getObject('Body').Tip is feature",
          ].join("\n"),
          requireSolids: true,
        },
        "earlier-original-readback",
      );
    }),
  90_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind使用真实草图轴和非单位Body/Sketch Placement，STEP核对世界坐标",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_run_python",
        {
          source: [
            "body=doc.addObject('PartDesign::Body','Body')",
            "body.Placement=App.Placement(App.Vector(100,200,30),App.Rotation(App.Vector(0,0,1),90))",
            "sketch=body.newObject('Sketcher::SketchObject','Sketch')",
            "sketch.Placement=App.Placement(App.Vector(3,4,2),App.Rotation(App.Vector(0,0,1),30))",
            "points=[App.Vector(0,0,0),App.Vector(10,0,0),App.Vector(10,10,0),App.Vector(0,10,0)]",
            "sketch.addGeometry([Part.LineSegment(points[i],points[(i+1)%4]) for i in range(4)],False)",
            "pad=body.newObject('PartDesign::Pad','Pad')",
            "pad.Profile=sketch",
            "pad.Length=3",
            "doc.recompute()",
            "assert abs(pad.Shape.Volume-300)<1e-6",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-placement-seed`,
      );
      const extent = mode.dimension === "length" ? 21 : 360;
      const created = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: seed.outputPath,
          operations: [
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: extent,
              occurrences: 4,
            },
          ],
        },
        `${mode.dimension}-placement-pattern`,
      );
      const expected = mode.dimension === "length" ? 930 : 1200;
      expect(
        created.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(expected, 6);
      const exported = await call(
        fixture,
        "cad_export",
        {
          documentPath: created.outputPath,
          objectNames: ["Body"],
          format: "step",
        },
        `${mode.dimension}-placement-step`,
      );
      const checked = await call(
        fixture,
        "cad_run_python",
        {
          source: [
            "shape=Part.Shape()",
            `shape.read(${JSON.stringify(exported.outputPath)})`,
            "doc.addObject('Part::Feature','Roundtrip').Shape=shape",
            "box=shape.BoundBox",
            "result={'bounds':[box.XMin,box.YMin,box.ZMin,box.XMax,box.YMax,box.ZMax]}",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-placement-step-readback`,
      );
      const bounds = z
        .object({ bounds: z.array(z.number()).length(6) })
        .parse(checked.data).bounds;
      const c = Math.cos((2 * Math.PI) / 3),
        s = Math.sin((2 * Math.PI) / 3);
      const expectedBounds =
        mode.dimension === "length"
          ? [96 + 31 * c - 10 * s, 203 + 10 * c, 32, 96, 203 + 31 * s, 35]
          : [
              96 - 10 * (s - c),
              203 - 10 * (s - c),
              32,
              96 + 10 * (s - c),
              203 + 10 * (s - c),
              35,
            ];
      bounds.forEach((value, index) => {
        expect(value).toBeCloseTo(expectedBounds[index] ?? Number.NaN, 5);
      });
    }),
  120_000,
);

const axisCases = modes.flatMap((mode) =>
  ["H_Axis", "V_Axis", "N_Axis"].map((axis) => ({ ...mode, axis })),
);
test.skipIf(nativeUnavailable).each(axisCases)(
  "$kind/$axis覆盖全部草图主轴，并读取实际体积与范围",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const created = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...baseOperations,
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: mode.dimension === "length" ? 8 : 360,
              occurrences: mode.dimension === "length" ? 3 : 4,
              reversed: true,
            },
          ],
        },
        `${mode.dimension}-${mode.axis}-all-axes`,
      );
      const shape = created.document?.objects.find(
        (obj) => obj.name === "Pattern",
      )?.shape;
      expect(shape?.volume).toBeCloseTo(
        mode.dimension === "length"
          ? mode.axis === "N_Axis"
            ? 1300
            : 900
          : 2000,
        6,
      );
      const expected =
        mode.dimension === "length"
          ? mode.axis === "H_Axis"
            ? [-8, 0, 0, 10, 10, 5]
            : mode.axis === "V_Axis"
              ? [0, -8, 0, 10, 10, 5]
              : [0, 0, -8, 10, 10, 5]
          : mode.axis === "H_Axis"
            ? [0, -10, -10, 10, 10, 10]
            : mode.axis === "V_Axis"
              ? [-10, 0, -10, 10, 10, 10]
              : [-10, -10, 0, 10, 10, 5];
      expect(shape?.bounds).toHaveLength(6);
      shape?.bounds?.forEach((value, index) => {
        expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
      });
    }),
  60_000,
);

test.skipIf(nativeUnavailable)(
  "原生Angle直接赋720会夹到360，与保留多圈表达式路径区分",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...baseOperations,
            {
              kind: "create_polar_pattern",
              name: "Pattern",
              body: "Body",
              original: "Pad",
              axis: { sketch: "Sketch", axis: "N_Axis" },
              angle: 360,
              occurrences: 4,
            },
          ],
        },
        "angle-clamp-seed",
      );
      const observed = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            "feature.Angle=720",
            "doc.recompute()",
            "result={'actualAngle':feature.Angle.Value}",
          ].join("\n"),
          requireSolids: true,
        },
        "angle-clamp-native",
      );
      expect(observed.data).toEqual({ actualAngle: 360 });
    }),
  60_000,
);
