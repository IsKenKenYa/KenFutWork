import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { invokeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";

async function assemblySource(options: Record<string, unknown>) {
  const fixture = await readFile(
    new URL("./fixtures/assembly-fixed.py", import.meta.url),
    "utf8",
  );
  return `import json\n${fixture}\nresult=run_fixed_case(json.loads(${JSON.stringify(JSON.stringify(options))}))`;
}

const dimensions = z.tuple([
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
]);
const parameters = z.object({ fixed: dimensions, moving: dimensions });
const residuals = z.object({
  position: z.number().finite().nonnegative(),
  axisMax: z.number().finite().nonnegative(),
  axes: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
});
const measurement = z.object({ residuals }).passthrough();
const grounding = z.object({
  fixedGrounded: z.literal(true),
  fixedConnected: z.literal(true),
  movingConnected: z.literal(true),
});
const assemblyDataSchema = z.object({
  capability: z.literal("assembly_fixed"),
  reused: z.boolean(),
  jointType: z.literal("Fixed"),
  objects: z.record(z.string(), z.string()),
  solverCodes: z.tuple([z.literal(0), z.literal(0)]),
  parameters,
  residuals,
  groundedPlacementUnchanged: z.literal(true),
  grounding,
  stages: z
    .array(
      z.object({
        solverCode: z.literal(0),
        parameters,
        before: measurement,
        after: measurement,
        groundedPlacementUnchanged: z.literal(true),
        grounding,
      }),
    )
    .length(2),
});

function checkAssembly(
  result: ReturnType<typeof cadResultSchema.parse>,
  expected: z.infer<typeof parameters>,
  reused: boolean,
) {
  const data = assemblyDataSchema.parse(result.data);
  expect(data.reused).toBe(reused);
  expect(data.parameters).toEqual(expected);
  expect(
    result.document?.objects.filter(
      (obj) => obj.type === "Assembly::AssemblyObject",
    ),
  ).toHaveLength(1);
  for (const role of ["fixed", "moving"] as const) {
    const shape = result.document?.objects.find(
      (obj) => obj.name === data.objects[role],
    )?.shape;
    expect(shape?.solids).toBe(1);
    expect(shape?.volume).toBeCloseTo(
      expected[role].reduce((a, b) => a * b, 1),
      6,
    );
  }
  for (const stage of data.stages) {
    expect(stage.before.residuals.position).toBeGreaterThan(1);
    expect(stage.before.residuals.axisMax).toBeGreaterThan(1e-6);
    expect(stage.after.residuals.position).toBeLessThan(1e-6);
    expect(stage.after.residuals.axisMax).toBeLessThan(1e-6);
    for (const value of Object.values(stage.after.residuals.axes))
      expect(Math.abs(value)).toBeLessThan(1e-6);
  }
  expect(data.residuals.position).toBeLessThan(1e-6);
  expect(data.residuals.axisMax).toBeLessThan(1e-6);
  return data;
}

test.skipIf(nativeUnavailable)(
  "内置Assembly真实固定装配经Task交付，保存重开后可再次求解且源工程保持",
  async () =>
    withNativeCad(async (fixture) => {
      const created = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        { source: await assemblySource({}), requireSolids: true },
        "assembly-fixed-initial",
      );
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const authored = cadResultSchema.parse(created.structuredContent);
      checkAssembly(
        authored,
        { fixed: [26, 12, 11], moving: [9, 6, 6] },
        false,
      );
      const sourcePath = z.string().parse(authored.outputPath);
      const bytes = await readFile(sourcePath);
      const described = await invokeCadTestTool(
        fixture,
        "cad_describe_document",
        { documentPath: sourcePath },
        "assembly-fixed-described",
      );
      expect(described.isError, JSON.stringify(described)).not.toBe(true);
      let path = sourcePath;
      for (const [index, expected] of [
        { fixed: [35, 12, 14], moving: [13, 8, 7] },
        { fixed: [20, 12, 8], moving: [7, 5, 4] },
      ].entries()) {
        const previous = await readFile(path);
        const reopened = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            documentPath: path,
            source: await assemblySource({
              resizedFixedDimensions: expected.fixed,
              resizedMovingDimensions: expected.moving,
            }),
            requireSolids: true,
          },
          `assembly-fixed-reopened-${index}`,
        );
        expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
        const checked = cadResultSchema.parse(reopened.structuredContent);
        checkAssembly(checked, parameters.parse(expected), true);
        expect(await readFile(path)).toEqual(previous);
        path = z.string().parse(checked.outputPath);
      }
      const exported = await invokeCadTestTool(
        fixture,
        "cad_export",
        {
          documentPath: path,
          format: "step",
          objectNames: ["KfwFixedPart", "KfwMovingPart"],
        },
        "assembly-fixed-exchange",
      );
      expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
      const exchange = z
        .string()
        .parse(cadResultSchema.parse(exported.structuredContent).outputPath);
      const imported = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          source: [
            "exchanged = doc.addObject('Part::Feature', 'Exchanged')",
            `exchanged.Shape = Part.read(${JSON.stringify(exchange)})`,
            "assert len(exchanged.Shape.Solids) == 2",
          ].join("\n"),
          requireSolids: true,
          expectedVolume: {
            objectName: "Exchanged",
            value: 20 * 12 * 8 + 7 * 5 * 4,
          },
        },
        "assembly-fixed-exchange-readback",
      );
      expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
      expect(await readFile(sourcePath)).toEqual(bytes);
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "无显式固定基准时求解码0仍可能未对齐，脚本按真实连接状态与残差拒绝交付",
  async () =>
    withNativeCad(async (fixture) => {
      const created = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        { source: await assemblySource({}), requireSolids: true },
        "assembly-ground-baseline",
      );
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const sourcePath = z
        .string()
        .parse(cadResultSchema.parse(created.structuredContent).outputPath);
      const before = await readFile(sourcePath);
      const outputPath = join(fixture.root, "ungrounded.FCStd");
      const fixtureSource = await readFile(
        new URL("./fixtures/assembly-fixed.py", import.meta.url),
        "utf8",
      );
      const rejected = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          documentPath: sourcePath,
          outputPath,
          requireSolids: true,
          source: [
            fixtureSource,
            "assembly = doc.getObject('KfwFixedAssembly')",
            "doc.removeObject('KfwGrounded')",
            "fixed, moving, joint = (doc.getObject(_FIXED_NAMES[role]) for role in ('fixed', 'moving', 'joint'))",
            "objects = {'fixed':fixed, 'moving':moving, 'joint':joint}",
            "moving.Placement = App.Placement(App.Vector(-30,45,16), App.Rotation(App.Vector(1,1,0),37))",
            "joint.Proxy.updateJCSPlacements(joint)",
            "code = assembly.solve()",
            "assert code == 0, '本例需验证原生过滤未连接关节后仍返回0的边界'",
            "assert not assembly.isPartGrounded(fixed)",
            "assert not assembly.isPartConnected(fixed) and not assembly.isPartConnected(moving)",
            "measured = _fixed_measure(objects)",
            "assert measured['residuals']['position'] < 1e-6 and measured['residuals']['axisMax'] < 1e-6, 'Assembly连接器未对齐（求解返回0）'",
          ].join("\n"),
        },
        "assembly-ground-missing",
      );
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "execution_failed" } },
      });
      expect(JSON.stringify(rejected)).toContain(
        "Assembly连接器未对齐（求解返回0）",
      );
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sourcePath)).toEqual(before);
    }),
  60_000,
);
