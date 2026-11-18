import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
    dimension: "length",
    vector: "direction",
    axis: "H_Axis",
    extent: 20,
    count: 3,
  },
  {
    kind: "create_polar_pattern",
    dimension: "angle",
    vector: "axis",
    axis: "N_Axis",
    extent: 360,
    count: 4,
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

async function refuse(
  fixture: NativeCad,
  documentPath: string,
  operation: Record<string, unknown>,
  id: string,
  reason?: RegExp,
) {
  const before = await readFile(documentPath);
  const outputPath = join(fixture.root, `${id}.FCStd`);
  const result = await invokeCadTestTool(
    fixture,
    "cad_apply_operations",
    { documentPath, outputPath, operations: [operation] },
    id,
  );
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const error = z
    .object({
      error: z.object({
        code: z.literal("execution_failed"),
        message: z.string(),
      }),
    })
    .parse(result.structuredContent).error;
  if (reason) expect(error.message).toMatch(reason);
  await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(documentPath)).toEqual(before);
}

test.skipIf(nativeUnavailable).each(modes)(
  "$kind对真实Pocket减材阵列批改范围与数量，保存重开核对全部孔位和体积",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const created = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            { kind: "create_body", name: "Body" },
            {
              kind: "create_sketch",
              name: "Plate",
              body: "Body",
              profiles: [
                {
                  kind: "rectangle",
                  name: "Base",
                  origin: [-20, -20],
                  width: 40,
                  height: 40,
                },
              ],
            },
            {
              kind: "create_pad",
              name: "Pad",
              body: "Body",
              profile: "Plate",
              length: 5,
            },
            {
              kind: "create_sketch",
              name: "HoleSketch",
              body: "Body",
              supportPad: "Pad",
              profiles: [
                { kind: "circle", name: "Hole", center: [10, 0], radius: 2 },
              ],
            },
            {
              kind: "create_pocket",
              name: "Pocket",
              body: "Body",
              profile: "HoleSketch",
              mode: "through_all",
            },
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pocket",
              [mode.vector]: { sketch: "Plate", axis: mode.axis },
              [mode.dimension]: mode.extent,
              occurrences: mode.count,
              reversed: true,
            },
          ],
        },
        `${mode.dimension}-pocket-pattern`,
      );
      expect(
        created.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(8000 - mode.count * 20 * Math.PI, 6);
      const changed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: created.outputPath,
          operations: [
            {
              kind: "set_pattern_parameters",
              object: "Pattern",
              [mode.dimension]: mode.dimension === "length" ? 24 : 180,
              occurrences: 4,
            },
          ],
        },
        `${mode.dimension}-pocket-edited`,
      );
      expect(
        changed.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(8000 - 80 * Math.PI, 6);
      const points =
        mode.dimension === "length"
          ? [
              [10, 0],
              [2, 0],
              [-6, 0],
              [-14, 0],
            ]
          : [0, -60, -120, -180].map((angle) => [
              10 * Math.cos((angle * Math.PI) / 180),
              10 * Math.sin((angle * Math.PI) / 180),
            ]);
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: changed.outputPath,
          source: [
            "body,feature,original=[doc.getObject(name) for name in ('Body','Pattern','Pocket')]",
            "assert feature.BaseFeature is original and list(feature.Originals)==[original] and body.Tip is feature",
            `for x,y in ${JSON.stringify(points)}:`,
            "    assert not feature.Shape.isInside(App.Vector(x,y,2.5),1e-7,True)",
            "assert feature.Shape.isInside(App.Vector(18,18,2.5),1e-7,True)",
            "assert feature.Occurrences==4",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-pocket-readback`,
      );
    }),
  120_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind拒绝跨Body原件/轴、非特征原件与名称碰撞，失败保持源文件",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
            { kind: "create_body", name: "OtherBody" },
            {
              kind: "create_sketch",
              name: "OtherSketch",
              body: "OtherBody",
              profiles: [
                { kind: "rectangle", name: "Other", width: 10, height: 10 },
              ],
            },
            {
              kind: "create_pad",
              name: "OtherPad",
              body: "OtherBody",
              profile: "OtherSketch",
              length: 5,
            },
          ],
        },
        `${mode.dimension}-guard-source`,
      );
      const path = z.string().parse(seed.outputPath);
      const operation = {
        kind: mode.kind,
        name: "Pattern",
        body: "Body",
        original: "Pad",
        [mode.vector]: { sketch: "Sketch", axis: mode.axis },
        [mode.dimension]: mode.extent,
        occurrences: mode.count,
      };
      for (const [name, changes] of [
        ["foreign-original", { original: "OtherPad" }],
        [
          "foreign-axis",
          { [mode.vector]: { sketch: "OtherSketch", axis: mode.axis } },
        ],
        ["missing-original", { original: "Missing" }],
        ["not-feature-original", { original: "Sketch" }],
        ["name-collision", { name: "Pad" }],
      ] as const)
        await refuse(
          fixture,
          path,
          { ...operation, ...changes },
          `${mode.dimension}-${name}`,
        );
      const created = await call(
        fixture,
        "cad_apply_operations",
        { documentPath: path, operations: [operation] },
        `${mode.dimension}-editable-pattern`,
      );
      const patternPath = z.string().parse(created.outputPath);
      await refuse(
        fixture,
        patternPath,
        { kind: "set_pattern_parameters", object: "Pad", occurrences: 2 },
        `${mode.dimension}-wrong-edit-type`,
        /不是线性或环形阵列/,
      );
      await refuse(
        fixture,
        patternPath,
        {
          kind: "set_pattern_parameters",
          object: "Pattern",
          [mode.dimension === "length" ? "angle" : "length"]: 15,
        },
        `${mode.dimension}-wrong-extent`,
        /不支持所请求的范围参数/,
      );
      const expression = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: patternPath,
          source: [
            "feature=doc.getObject('Pattern')",
            `feature.setExpression(${JSON.stringify(mode.dimension === "length" ? "Length" : "Angle")}, ${JSON.stringify(mode.dimension === "length" ? "20 mm" : "360 deg")})`,
            "doc.recompute()",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-expression-source`,
      );
      await refuse(
        fixture,
        z.string().parse(expression.outputPath),
        {
          kind: "set_pattern_parameters",
          object: "Pattern",
          [mode.dimension]: 10,
        },
        `${mode.dimension}-expression-edit`,
        /已有表达式/,
      );
    }),
  180_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind只改数量时允许已有范围表达式联动，保持绑定文本",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const factor = mode.dimension === "length" ? 5 : 90;
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: factor * 3,
              occurrences: 3,
            },
          ],
        },
        `${mode.dimension}-driven-seed`,
      );
      const driven = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            `feature.setExpression(${JSON.stringify(mode.dimension === "length" ? "Length" : "Angle")},${JSON.stringify(`Occurrences * ${factor} ${mode.dimension === "length" ? "mm" : "deg"}`)})`,
            "doc.recompute()",
            "result={'bindings':feature.ExpressionEngine}",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-driven-source`,
      );
      const changed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: driven.outputPath,
          operations: [
            {
              kind: "set_pattern_parameters",
              object: "Pattern",
              occurrences: 4,
            },
          ],
        },
        `${mode.dimension}-driven-count`,
      );
      const checked = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: changed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            `assert feature.Occurrences==4 and abs(feature.${mode.dimension === "length" ? "Length" : "Angle"}.Value-${factor * 4})<1e-7`,
            "result={'bindings':feature.ExpressionEngine}",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-driven-readback`,
      );
      expect(checked.data).toEqual(driven.data);
      if (mode.dimension === "angle") {
        const repeated = await call(
          fixture,
          "cad_apply_operations",
          {
            documentPath: changed.outputPath,
            operations: [
              {
                kind: "set_pattern_parameters",
                object: "Pattern",
                occurrences: 8,
              },
            ],
          },
          "polar-expression-two-turns",
        );
        const checkedTurns = await call(
          fixture,
          "cad_run_python",
          {
            documentPath: repeated.outputPath,
            source: [
              "feature=doc.getObject('Pattern')",
              "assert feature.Occurrences==8 and abs(feature.Angle.Value-720)<1e-7",
              "result={'bindings':feature.ExpressionEngine}",
            ].join("\n"),
            requireSolids: true,
          },
          "polar-expression-two-turns-readback",
        );
        expect(checkedTurns.data).toEqual(driven.data);
      }
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "环形阵列尊重原生近360度分支，不把非整周误算成均匀整周",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
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
        "polar-full-turn-seed",
      );
      for (const [index, angle] of [360, 360 - 5e-8, 360 - 2e-7].entries()) {
        const changed = await call(
          fixture,
          "cad_apply_operations",
          {
            documentPath: seed.outputPath,
            operations: [
              { kind: "set_pattern_parameters", object: "Pattern", angle },
            ],
          },
          `polar-angle-${index}`,
        );
        const checked = await call(
          fixture,
          "cad_run_python",
          {
            documentPath: changed.outputPath,
            source: [
              "feature=doc.getObject('Pattern')",
              `assert abs(feature.Angle.Value-${angle})<1e-10 and feature.Occurrences==4`,
              "result={'containsCorner':feature.Shape.isInside(App.Vector(-9,9,2.5),1e-7,True)}",
            ].join("\n"),
            requireSolids: true,
          },
          `polar-angle-check-${index}`,
        );
        expect(checked.data).toEqual({
          containsCorner: Math.abs(angle - 360) < 1e-7,
        });
      }
    }),
  120_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind编辑早期阵列保留后继Fillet的Tip、原生引用与可见性",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const extent = mode.dimension === "length" ? 21 : 360;
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
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
        `${mode.dimension}-downstream-seed`,
      );
      const described = await call(
        fixture,
        "cad_describe_document",
        { documentPath: seed.outputPath, edges: { objectName: "Pattern" } },
        `${mode.dimension}-downstream-edges`,
      );
      const coordinate = mode.dimension === "length" ? 0 : 10;
      const selected = described.edgePage?.items.filter(
        (edge) =>
          edge.vertices.length === 2 &&
          edge.vertices.every(
            (point) =>
              Math.abs(point[0] - coordinate) < 1e-7 &&
              Math.abs(point[1] - coordinate) < 1e-7,
          ),
      );
      expect(selected).toHaveLength(1);
      const dressed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: seed.outputPath,
          operations: [
            {
              kind: "create_fillet",
              name: "Last",
              body: "Body",
              base: "Pattern",
              edges: [selected?.[0]?.name],
              radius: 1,
            },
          ],
        },
        `${mode.dimension}-downstream-fillet`,
      );
      const changed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: dressed.outputPath,
          operations: [
            {
              kind: "set_pattern_parameters",
              object: "Pattern",
              [mode.dimension]: mode.dimension === "length" ? 24 : 180,
              occurrences: mode.dimension === "length" ? 4 : 3,
            },
          ],
        },
        `${mode.dimension}-upstream-pattern-edit`,
      );
      const expected =
        (mode.dimension === "length" ? 1700 : 1500) - (1 - Math.PI / 4) * 5;
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: changed.outputPath,
          source: [
            "body,feature,last,pad=[doc.getObject(name) for name in ('Body','Pattern','Last','Pad')]",
            "assert body.Tip is last and last.BaseFeature is feature and last.Base[0] is feature",
            "assert feature.BaseFeature is pad and list(feature.Originals)==[pad]",
            "assert not feature.ViewObject.Visibility and last.ViewObject.Visibility",
            `assert abs(body.Shape.Volume-${expected})<1e-6`,
            "assert feature.getStatusString()==last.getStatusString()=='Valid'",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-downstream-readback`,
      );
    }),
  120_000,
);

const flagCases = modes.flatMap(
  (mode) =>
    [
      {
        ...mode,
        property: "Occurrences",
        flag: "ReadOnly",
        changes: { occurrences: 5 },
      },
      {
        ...mode,
        property: "Reversed",
        flag: "Immutable",
        changes: { reversed: true },
      },
    ] as const,
);

test.skipIf(nativeUnavailable).for(flagCases)(
  "$kind原生$flag保护$property，保存重开后拒绝直接批改",
  { timeout: 90_000 },
  async (mode, context) => {
    let lostFlag = false;
    await withNativeCad(async (fixture) => {
      const id = `${mode.dimension}-${mode.flag}`;
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: mode.extent,
              occurrences: mode.count,
            },
          ],
        },
        `${id}-seed`,
      );
      const protectedSource = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            `feature.setPropertyStatus(${JSON.stringify(mode.property)},${JSON.stringify(mode.flag)})`,
            `assert ${JSON.stringify(mode.flag)} in feature.getPropertyStatus(${JSON.stringify(mode.property)})`,
          ].join("\n"),
          requireSolids: true,
        },
        `${id}-protected-source`,
      );
      const reopened = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: protectedSource.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            `result={'persisted':${JSON.stringify(mode.flag)} in feature.getPropertyStatus(${JSON.stringify(mode.property)})}`,
          ].join("\n"),
          requireSolids: true,
        },
        `${id}-protected-reopened`,
      );
      if (
        !z.object({ persisted: z.boolean() }).parse(reopened.data).persisted
      ) {
        lostFlag = true;
        return;
      }
      await refuse(
        fixture,
        z.string().parse(protectedSource.outputPath),
        { kind: "set_pattern_parameters", object: "Pattern", ...mode.changes },
        `${id}-refused`,
        /不可修改/,
      );
    });
    if (lostFlag)
      context.skip(
        `FreeCAD未跨保存重开保留${mode.property}.${mode.flag}，本项拒绝行为未验收`,
      );
  },
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind保留未支持的原生Spacing模式，拒绝用Extent参数偷偷改配置",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: mode.extent,
              occurrences: mode.count,
            },
          ],
        },
        `${mode.dimension}-spacing-seed`,
      );
      const spacing = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            "feature.Mode='Spacing'",
            `feature.Offset=${mode.dimension === "length" ? 5 : 90}`,
            "doc.recompute()",
            "assert feature.Mode=='Spacing' and feature.getStatusString()=='Valid'",
          ].join("\n"),
          requireSolids: true,
        },
        `${mode.dimension}-spacing-source`,
      );
      await refuse(
        fixture,
        z.string().parse(spacing.outputPath),
        { kind: "set_pattern_parameters", object: "Pattern", occurrences: 5 },
        `${mode.dimension}-spacing-refused`,
        /总范围模式/,
      );
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "批改线性阵列的范围和数量可同时生效，保留单实体及Refine配置",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
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
        "coupled-pattern-seed",
      );
      const configured = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source:
            "doc.getObject('Body').AllowCompound=False\ndoc.getObject('Pattern').Refine=False\ndoc.recompute()",
          requireSolids: true,
        },
        "coupled-pattern-config",
      );
      const changed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: configured.outputPath,
          operations: [
            {
              kind: "set_pattern_parameters",
              object: "Pattern",
              length: 60,
              occurrences: 8,
            },
          ],
        },
        "coupled-pattern-edit",
      );
      expect(
        changed.document?.objects.find((obj) => obj.name === "Pattern")?.shape,
      ).toMatchObject({ solids: 1, volume: expect.closeTo(3500, 6) });
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: changed.outputPath,
          source: [
            "body,feature=doc.getObject('Body'),doc.getObject('Pattern')",
            "assert not body.AllowCompound and not feature.Refine and feature.Occurrences==8",
            "assert abs(feature.Length.Value-60)<1e-7",
          ].join("\n"),
          requireSolids: true,
        },
        "coupled-pattern-readback",
      );
      const twoDirections = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            "feature.Direction2=(doc.getObject('Sketch'),['V_Axis'])",
            "feature.Length2=8",
            "feature.Occurrences2=2",
            "doc.recompute()",
            "assert feature.getStatusString()=='Valid'",
          ].join("\n"),
          requireSolids: true,
        },
        "two-directions-source",
      );
      await refuse(
        fixture,
        z.string().parse(twoDirections.outputPath),
        { kind: "set_pattern_parameters", object: "Pattern", length: 20 },
        "two-directions-refused",
        /单方向/,
      );
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "已抑制的历史原件不被原生静默过滤成成功阵列",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [...createCadPadTestOperations()],
        },
        "suppressed-seed",
      );
      const suppressed = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: seed.outputPath,
          source: [
            "body,pad=doc.getObject('Body'),doc.getObject('Pad')",
            "extra=body.newObject('PartDesign::AdditiveBox','Extra')",
            "extra.Length,extra.Width,extra.Height=10,10,5",
            "pad.Suppressed=True",
            "doc.recompute()",
            "assert pad.Suppressed and body.Tip is extra and extra.getStatusString()=='Valid'",
          ].join("\n"),
          requireSolids: true,
        },
        "suppressed-source",
      );
      await refuse(
        fixture,
        z.string().parse(suppressed.outputPath),
        {
          kind: "create_linear_pattern",
          name: "Pattern",
          body: "Body",
          original: "Pad",
          direction: { sketch: "Sketch", axis: "H_Axis" },
          length: 20,
          occurrences: 3,
        },
        "suppressed-refused",
        /已被抑制/,
      );
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "Revolution增材阵列支持改上游旋转角，保持全部副本和原生参数链",
  async () =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            { kind: "create_body", name: "Body" },
            {
              kind: "create_sketch",
              name: "Sketch",
              body: "Body",
              profiles: [
                {
                  kind: "rectangle",
                  name: "Section",
                  origin: [5, 0],
                  width: 5,
                  height: 5,
                },
              ],
            },
            {
              kind: "create_revolution",
              name: "Revolution",
              body: "Body",
              profile: "Sketch",
              axis: "y",
              angle: 360,
            },
            {
              kind: "create_linear_pattern",
              name: "Pattern",
              body: "Body",
              original: "Revolution",
              direction: { sketch: "Sketch", axis: "V_Axis" },
              length: 15,
              occurrences: 4,
            },
          ],
        },
        "revolution-pattern-seed",
      );
      expect(
        seed.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(1500 * Math.PI, 6);
      const changed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: seed.outputPath,
          operations: [
            {
              kind: "set_dimension",
              object: "Revolution",
              dimension: "angle",
              value: 180,
            },
          ],
        },
        "revolution-pattern-upstream-edit",
      );
      expect(
        changed.document?.objects.find((obj) => obj.name === "Pattern")?.shape
          ?.volume,
      ).toBeCloseTo(750 * Math.PI, 6);
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: changed.outputPath,
          source: [
            "feature=doc.getObject('Pattern')",
            "assert feature.BaseFeature is doc.getObject('Revolution') and list(feature.Originals)==[doc.getObject('Revolution')]",
            "assert feature.Shape.isInside(App.Vector(0,10,-7),1e-7,True)",
            "assert not feature.Shape.isInside(App.Vector(0,10,7),1e-7,True)",
          ].join("\n"),
          requireSolids: true,
        },
        "revolution-pattern-readback",
      );
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "普通空形状不能伪装成抑制特征，原生未抑制的空特征仍拒绝",
  async () =>
    withNativeCad(async (fixture) => {
      for (const [index, type] of [
        "Part::Feature",
        "PartDesign::Feature",
      ].entries()) {
        const outputPath = join(fixture.root, `fake-suppressed-${index}.FCStd`);
        const result = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            outputPath,
            source: [
              "valid=doc.addObject('Part::Box','ValidModel')",
              `fake=doc.addObject(${JSON.stringify(type)},'EmptyFeature')`,
              "fake.Shape=Part.Shape()",
              ...(type === "Part::Feature"
                ? [
                    "fake.addProperty('App::PropertyBool','Suppressed')",
                    "fake.Suppressed=True",
                  ]
                : ["assert not fake.Suppressed"]),
            ].join("\n"),
            requireSolids: true,
          },
          `fake-suppressed-${index}`,
        );
        expect(result.isError, JSON.stringify(result)).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: "execution_failed",
            message: expect.stringMatching(/EmptyFeature/),
          },
        });
        await expect(stat(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }),
  60_000,
);

test.skipIf(nativeUnavailable).each(modes)(
  "$kind减少数量删除后继Fillet所引用的实例时拒绝发布，保留源工程",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await call(
        fixture,
        "cad_apply_operations",
        {
          operations: [
            ...createCadPadTestOperations(),
            {
              kind: mode.kind,
              name: "Pattern",
              body: "Body",
              original: "Pad",
              [mode.vector]: { sketch: "Sketch", axis: mode.axis },
              [mode.dimension]: mode.dimension === "length" ? 30 : 360,
              occurrences: 4,
            },
          ],
        },
        `${mode.dimension}-deleted-instance-seed`,
      );
      const described = await call(
        fixture,
        "cad_describe_document",
        { documentPath: seed.outputPath, edges: { objectName: "Pattern" } },
        `${mode.dimension}-deleted-instance-edges`,
      );
      const x = mode.dimension === "length" ? 40 : 10,
        y = mode.dimension === "length" ? 0 : -10;
      const edges = described.edgePage?.items.filter(
        (edge) =>
          edge.vertices.length === 2 &&
          edge.vertices.every(
            (point) =>
              Math.abs(point[0] - x) < 1e-7 && Math.abs(point[1] - y) < 1e-7,
          ),
      );
      expect(edges).toHaveLength(1);
      const dressed = await call(
        fixture,
        "cad_apply_operations",
        {
          documentPath: seed.outputPath,
          operations: [
            {
              kind: "create_fillet",
              name: "Last",
              body: "Body",
              base: "Pattern",
              edges: [edges?.[0]?.name],
              radius: 1,
            },
          ],
        },
        `${mode.dimension}-deleted-instance-fillet`,
      );
      await refuse(
        fixture,
        z.string().parse(dressed.outputPath),
        { kind: "set_pattern_parameters", object: "Pattern", occurrences: 1 },
        `${mode.dimension}-deleted-instance-refused`,
        /重算|求解|link|Link|空|无效/,
      );
    }),
  90_000,
);
