import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { executeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { type CadResult, cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];
type Operation = Record<string, unknown>;

const nativeUnavailable =
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
  process.platform !== "darwin";

function outputPath(result: CadResult): string {
  return z.string().min(1).parse(result.outputPath);
}

async function operations(
  fixture: NativeCad,
  input: {
    documentPath?: string;
    outputPath?: string;
    operations: Operation[];
  },
  callId: string,
) {
  const tool = createCadTools(fixture.service).find(
    (item) => item.name === "cad_apply_operations",
  );
  if (!tool) throw new Error("缺少结构化 CAD 工具");
  return executeCadTestTool(tool, input, {
    ...fixture.context,
    toolCallId: callId,
  });
}

async function apply(
  fixture: NativeCad,
  input: Parameters<typeof operations>[1],
  callId: string,
) {
  const result = await operations(fixture, input, callId);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return cadResultSchema.parse(result.structuredContent);
}

async function python(
  fixture: NativeCad,
  documentPath: string,
  lines: string[],
  callId: string,
) {
  const result = await fixture.service.execute(
    { action: "python", input: { documentPath, source: lines.join("\n") } },
    { ...fixture.context, toolCallId: callId },
  );
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return cadResultSchema.parse(result.structuredContent);
}

function padOperations(): Operation[] {
  return [
    { kind: "create_body", name: "Body", label: "参数板" },
    {
      kind: "create_sketch",
      name: "PlateSketch",
      body: "Body",
      profiles: [{ kind: "rectangle", name: "Plate", width: 40, height: 30 }],
    },
    {
      kind: "create_pad",
      name: "Pad",
      label: "板厚",
      body: "Body",
      profile: "PlateSketch",
      length: 10,
    },
  ];
}

function holeSketch(name = "HoleSketch", center = [20, 15]): Operation {
  return {
    kind: "create_sketch",
    name,
    body: "Body",
    supportPad: "Pad",
    profiles: [{ kind: "circle", name: "Hole", radius: 4, center }],
  };
}

function pocket(mode: "depth" | "through_all" = "depth"): Operation {
  return {
    kind: "create_pocket",
    name: "Pocket",
    label: "孔",
    body: "Body",
    profile: "HoleSketch",
    mode,
    ...(mode === "depth" ? { depth: 5 } : {}),
  };
}

async function createPadSeed(fixture: NativeCad, callId: string) {
  return apply(fixture, { operations: padOperations() }, callId);
}

async function verifyStep(
  fixture: NativeCad,
  documentPath: string,
  expectedVolume: number,
) {
  const exported = await fixture.service.execute(
    {
      action: "export",
      input: { documentPath, format: "step", objectNames: ["Body"] },
    },
    { ...fixture.context, toolCallId: "solid-step-export" },
  );
  expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
  const stepPath = outputPath(
    cadResultSchema.parse(exported.structuredContent),
  );
  expect(await readFile(stepPath, "utf8")).toContain("ISO-10303-21");
  await python(
    fixture,
    documentPath,
    [
      "import math",
      "roundtrip = doc.addObject('Part::Feature', 'StepReadback')",
      `roundtrip.Shape = Part.read(${JSON.stringify(stepPath)})`,
      "shape = roundtrip.Shape",
      "assert not shape.isNull() and shape.isValid() and len(shape.Solids) == 1",
      `assert math.isclose(shape.Volume, ${expectedVolume}, abs_tol=1e-5), 'STEP体积与交付几何不符'`,
      "bounds = shape.BoundBox",
      "actual = [bounds.XMin, bounds.YMin, bounds.ZMin, bounds.XMax, bounds.YMax, bounds.ZMax]",
      "assert all(abs(a-b) < 1e-5 for a,b in zip(actual, [65,200,30,100,250,42])), 'STEP丢失Body变换或物理尺寸'",
    ],
    "solid-step-readback",
  );
}

async function refuse(
  fixture: NativeCad,
  input: Parameters<typeof operations>[1],
  callId: string,
  reason?: RegExp,
  expectedCode = "execution_failed",
) {
  const before = input.documentPath
    ? await readFile(input.documentPath)
    : undefined;
  const destination = join(fixture.root, `${callId}.FCStd`);
  const result = await operations(
    fixture,
    { ...input, outputPath: destination },
    callId,
  );
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const error = z
    .object({
      error: z.object({ code: z.string(), message: z.string().optional() }),
    })
    .parse(result.structuredContent).error;
  expect(error.code).toBe(expectedCode);
  if (reason) expect(z.string().min(1).parse(error.message)).toMatch(reason);
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  if (input.documentPath)
    expect(await readFile(input.documentPath)).toEqual(before);
}

it.skipIf(nativeUnavailable)(
  "结构化拉伸和切除保留参数链，厚度与孔深和草图尺寸可改，贯穿分支及变换后STEP保持实体",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await createPadSeed(fixture, "solid-pad-seed");
      expect(seed.data).toMatchObject({
        operations: [
          {},
          {},
          {
            objectName: "Pad",
            bodyName: "Body",
            profileName: "PlateSketch",
            baseFeatureName: null,
            tip: "Pad",
            length: 10,
            volume: 12000,
            solids: 1,
          },
        ],
      });
      const seedPath = outputPath(seed);
      const seedBytes = await readFile(seedPath);
      const finite = await apply(
        fixture,
        { documentPath: seedPath, operations: [holeSketch(), pocket()] },
        "solid-finite-pocket",
      );
      expect(finite.data).toMatchObject({
        operations: [
          { objectName: "HoleSketch", supportPad: "Pad", placementZ: 10 },
          {
            objectName: "Pocket",
            bodyName: "Body",
            profileName: "HoleSketch",
            baseFeatureName: "Pad",
            tip: "Pocket",
            mode: "depth",
            depth: 5,
            solids: 1,
          },
        ],
      });
      const finiteShape = finite.document?.objects.find(
        (object) => object.name === "Body",
      )?.shape;
      expect(finiteShape?.volume).toBeCloseTo(12000 - Math.PI * 16 * 5, 6);
      const finitePath = outputPath(finite);
      const finiteBytes = await readFile(finitePath);
      const changed = await apply(
        fixture,
        {
          documentPath: finitePath,
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 12,
            },
            {
              kind: "set_dimension",
              object: "Pocket",
              dimension: "depth",
              value: 6,
            },
            {
              kind: "set_dimension",
              object: "PlateSketch",
              profile: "Plate",
              dimension: "width",
              value: 50,
            },
            {
              kind: "set_dimension",
              object: "PlateSketch",
              profile: "Plate",
              dimension: "height",
              value: 35,
            },
            {
              kind: "set_dimension",
              object: "HoleSketch",
              profile: "Hole",
              dimension: "radius",
              value: 5,
            },
          ],
        },
        "solid-edit-parameters",
      );
      const expectedVolume = 21000 - Math.PI * 25 * 6;
      const checked = await python(
        fixture,
        outputPath(changed),
        [
          "import math, zipfile",
          `with zipfile.ZipFile(${JSON.stringify(outputPath(changed))}) as archive:`,
          "    assert 'GuiDocument.xml' in archive.namelist(), '原生工程未保存可见性'",
          "body, pad, hole, tip = [doc.getObject(name) for name in ['Body', 'Pad', 'HoleSketch', 'Pocket']]",
          "assert body.Label == '参数板' and pad.Label == '板厚' and tip.Label == '孔'",
          "assert body.Tip == tip and tip.Profile[0] == hole and pad.Profile[0] == doc.getObject('PlateSketch')",
          "assert body.ViewObject.Visibility and tip.ViewObject.Visibility",
          "assert hole.FullyConstrained and doc.getObject('PlateSketch').FullyConstrained",
          "assert not hole.ViewObject.Visibility and not doc.getObject('PlateSketch').ViewObject.Visibility and not pad.ViewObject.Visibility",
          "assert abs(pad.Length.Value - 12) < 1e-6 and abs(tip.Length.Value - 6) < 1e-6",
          "assert abs(hole.Placement.Base.z - 12) < 1e-6 and abs(hole.Geometry[0].Radius - 5) < 1e-6",
          "assert len(body.Shape.Solids) == 1 and body.Shape.isValid()",
          `assert math.isclose(body.Shape.Volume, ${expectedVolume}, abs_tol=1e-6)`,
          "bounds = body.Shape.BoundBox",
          "assert all(abs(a-b) < 1e-6 for a,b in zip([bounds.XLength, bounds.YLength, bounds.ZLength], [50,35,12]))",
          "pad.Length = 14",
          "doc.recompute()",
          "assert abs(hole.Placement.Base.z - 14) < 1e-6, '原生改厚度后支撑草图没有联动'",
          "assert math.isclose(body.Shape.Volume, 24500 - math.pi * 25 * 6, abs_tol=1e-6)",
          "pad.Length = 12",
          "doc.recompute()",
          "body.Placement = App.Placement(App.Vector(100,200,30), App.Rotation(App.Vector(0,0,1),90))",
          "doc.recompute()",
          "assert abs(hole.getGlobalPlacement().Base.z - 42) < 1e-6",
        ],
        "solid-native-reopen-and-transform",
      );
      const transformed = await apply(
        fixture,
        {
          documentPath: outputPath(checked),
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 14,
            },
          ],
        },
        "solid-transformed-pad-edit",
      );
      await python(
        fixture,
        outputPath(transformed),
        [
          "import math",
          "body, pad, hole = [doc.getObject(name) for name in ['Body', 'Pad', 'HoleSketch']]",
          "assert abs(pad.Length.Value - 14) < 1e-6 and abs(hole.Placement.Base.z - 14) < 1e-6",
          "assert abs(hole.getGlobalPlacement().Base.z - 44) < 1e-6, '变换Body的孔世界坐标未随结构化厚度修改联动'",
          "assert body.Tip.Name == 'Pocket' and hole.FullyConstrained and doc.getObject('PlateSketch').FullyConstrained",
          "assert body.Shape.isValid() and len(body.Shape.Solids) == 1",
          "assert math.isclose(body.Shape.Volume, 24500 - math.pi * 25 * 6, abs_tol=1e-6)",
        ],
        "solid-transformed-pad-readback",
      );
      const restored = await apply(
        fixture,
        {
          documentPath: outputPath(transformed),
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 12,
            },
          ],
        },
        "solid-transformed-pad-restore",
      );
      await verifyStep(fixture, outputPath(restored), expectedVolume);
      const through = await apply(
        fixture,
        {
          documentPath: seedPath,
          operations: [holeSketch(), pocket("through_all")],
        },
        "solid-through-pocket",
      );
      expect(through.data).toMatchObject({
        operations: [{}, { mode: "through_all", tip: "Pocket", solids: 1 }],
      });
      expect(through.data).not.toHaveProperty("operations.1.depth");
      const throughEdited = await apply(
        fixture,
        {
          documentPath: outputPath(through),
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "length",
              value: 12,
            },
          ],
        },
        "solid-through-pad-edit",
      );
      await python(
        fixture,
        outputPath(throughEdited),
        [
          "import math",
          "body, pad, hole, cut = [doc.getObject(name) for name in ['Body', 'Pad', 'HoleSketch', 'Pocket']]",
          "assert body.Tip == cut and abs(pad.Length.Value - 12) < 1e-6",
          "assert list(cut.getEnumerationsOfProperty('Type')).index(cut.Type) == 1, '贯穿回执与原生切除模式不一致'",
          "assert abs(hole.Placement.Base.z - 12) < 1e-6",
          "assert body.Shape.isValid() and len(body.Shape.Solids) == 1",
          "assert math.isclose(body.Shape.Volume, 14400 - math.pi * 16 * 12, abs_tol=1e-6), '贯穿孔随板厚增加后留下材料'",
        ],
        "solid-through-reopen",
      );
      expect(await readFile(seedPath)).toEqual(seedBytes);
      expect(await readFile(finitePath)).toEqual(finiteBytes);
    }),
  180_000,
);

it.skipIf(nativeUnavailable)(
  "结构化实体拒绝跨Body、失配和重用轮廓、过时Tip、无材料切除及多实体，失败不发布且源工程不变",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await createPadSeed(fixture, "rejected-solid-seed");
      const seedPath = outputPath(seed);
      const seedBytes = await readFile(seedPath);
      const ready = await apply(
        fixture,
        { documentPath: seedPath, operations: [holeSketch()] },
        "rejected-solid-hole-seed",
      );
      const readyPath = outputPath(ready);
      const cut = await apply(
        fixture,
        { documentPath: readyPath, operations: [pocket()] },
        "rejected-solid-cut-seed",
      );
      const cases: Array<{
        name: string;
        documentPath?: string;
        operations: Operation[];
        expectedCode?: string;
      }> = [
        {
          name: "cross-body-pad",
          operations: [
            { kind: "create_body", name: "BodyA" },
            { kind: "create_body", name: "BodyB" },
            {
              kind: "create_sketch",
              name: "ForeignSketch",
              body: "BodyB",
              profiles: [{ kind: "circle", name: "Disc", radius: 5 }],
            },
            {
              kind: "create_pad",
              name: "WrongPad",
              body: "BodyA",
              profile: "ForeignSketch",
              length: 10,
            },
          ],
        },
        {
          name: "wrong-body-type",
          documentPath: seedPath,
          operations: [
            {
              kind: "create_pad",
              name: "WrongPad",
              body: "PlateSketch",
              profile: "PlateSketch",
              length: 10,
            },
          ],
        },
        {
          name: "wrong-profile-type",
          documentPath: seedPath,
          operations: [
            {
              kind: "create_pocket",
              name: "WrongPocket",
              body: "Body",
              profile: "Pad",
              mode: "depth",
              depth: 2,
            },
          ],
        },
        {
          name: "second-pad",
          documentPath: seedPath,
          operations: [
            {
              kind: "create_pad",
              name: "SecondPad",
              body: "Body",
              profile: "PlateSketch",
              length: 10,
            },
          ],
        },
        {
          name: "cross-body-pocket",
          documentPath: readyPath,
          operations: [
            { kind: "create_body", name: "OtherBody" },
            {
              kind: "create_sketch",
              name: "OtherPlate",
              body: "OtherBody",
              profiles: [
                { kind: "rectangle", name: "Stock", width: 40, height: 30 },
              ],
            },
            {
              kind: "create_pad",
              name: "OtherPad",
              body: "OtherBody",
              profile: "OtherPlate",
              length: 10,
            },
            { ...pocket(), name: "ForeignPocket", body: "OtherBody" },
          ],
        },
        {
          name: "unbound-pocket-profile",
          documentPath: seedPath,
          operations: [
            {
              kind: "create_sketch",
              name: "UnboundHole",
              body: "Body",
              profiles: [
                { kind: "circle", name: "Hole", radius: 4, center: [20, 15] },
              ],
            },
            { ...pocket(), profile: "UnboundHole" },
          ],
        },
        {
          name: "past-pad-tip",
          documentPath: outputPath(cut),
          operations: [{ ...pocket(), name: "SecondPocket" }],
        },
        {
          name: "no-removed-material",
          documentPath: seedPath,
          operations: [holeSketch("HoleSketch", [100, 100]), pocket()],
        },
        {
          name: "multiple-pad-solids",
          operations: [
            { kind: "create_body", name: "Body" },
            {
              kind: "create_sketch",
              name: "TwoDiscs",
              body: "Body",
              profiles: [
                { kind: "circle", name: "First", radius: 2 },
                { kind: "circle", name: "Second", radius: 2, center: [20, 0] },
              ],
            },
            {
              kind: "create_pad",
              name: "Pad",
              body: "Body",
              profile: "TwoDiscs",
              length: 10,
            },
          ],
        },
        {
          name: "pocket-splits-stock",
          documentPath: seedPath,
          operations: [
            {
              kind: "create_sketch",
              name: "SlotSketch",
              body: "Body",
              supportPad: "Pad",
              profiles: [
                {
                  kind: "rectangle",
                  name: "Slot",
                  width: 5,
                  height: 40,
                  origin: [17.5, -5],
                },
              ],
            },
            { ...pocket("through_all"), profile: "SlotSketch" },
          ],
        },
        {
          name: "through-all-depth-parameter",
          expectedCode: "invalid_arguments",
          documentPath: readyPath,
          operations: [{ ...pocket("through_all"), depth: 3 }],
        },
        {
          name: "length-on-sketch",
          documentPath: readyPath,
          operations: [
            {
              kind: "set_dimension",
              object: "HoleSketch",
              dimension: "length",
              value: 12,
            },
          ],
        },
        {
          name: "depth-on-pad",
          documentPath: seedPath,
          operations: [
            {
              kind: "set_dimension",
              object: "Pad",
              dimension: "depth",
              value: 6,
            },
          ],
        },
      ];
      for (const { name, expectedCode, ...input } of cases)
        await refuse(fixture, input, name, undefined, expectedCode);

      const rotated = await python(
        fixture,
        readyPath,
        [
          "sketch = doc.getObject('HoleSketch')",
          "placement = sketch.Placement",
          "placement.Rotation = App.Rotation(App.Vector(1,0,0),90)",
          "sketch.Placement = placement",
          "doc.recompute()",
        ],
        "rotated-hole-seed",
      );
      await refuse(
        fixture,
        { documentPath: outputPath(rotated), operations: [pocket()] },
        "rotated-hole-pocket",
      );
      const reused = await python(
        fixture,
        outputPath(cut),
        ["doc.getObject('Body').Tip = doc.getObject('Pad')", "doc.recompute()"],
        "reused-profile-seed",
      );
      await refuse(
        fixture,
        {
          documentPath: outputPath(reused),
          operations: [{ ...pocket(), name: "ReusedPocket" }],
        },
        "reused-profile-pocket",
      );
      expect(await readFile(seedPath)).toEqual(seedBytes);
    }),
  240_000,
);

it.skipIf(nativeUnavailable)(
  "表达式绑定的实体Length不被改写，贯穿Pocket没有可修改的有限深度",
  async () =>
    withNativeCad(async (fixture) => {
      const pad = await createPadSeed(fixture, "protected-solid-pad");
      const padPath = outputPath(pad);
      const finite = await apply(
        fixture,
        { documentPath: padPath, operations: [holeSketch(), pocket()] },
        "protected-solid-finite",
      );
      for (const [name, documentPath, dimension, expression] of [
        ["Pad", padPath, "length", "10 mm"],
        ["Pocket", outputPath(finite), "depth", "5 mm"],
      ] as const) {
        const protectedModel = await python(
          fixture,
          documentPath,
          [
            `doc.getObject('${name}').setExpression('Length', '${expression}')`,
            "doc.recompute()",
          ],
          `protected-${name}-seed`,
        );
        await refuse(
          fixture,
          {
            documentPath: outputPath(protectedModel),
            operations: [
              { kind: "set_dimension", object: name, dimension, value: 8 },
            ],
          },
          `protected-${name}-dimension`,
          /表达式/u,
        );
      }
      const through = await apply(
        fixture,
        {
          documentPath: padPath,
          operations: [holeSketch(), pocket("through_all")],
        },
        "protected-through-pocket",
      );
      await refuse(
        fixture,
        {
          documentPath: outputPath(through),
          operations: [
            {
              kind: "set_dimension",
              object: "Pocket",
              dimension: "depth",
              value: 6,
            },
          ],
        },
        "through-pocket-depth-edit",
      );
    }),
  120_000,
);
