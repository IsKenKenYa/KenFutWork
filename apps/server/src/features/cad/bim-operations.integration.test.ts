import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { invokeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";

const parametersSchema = z.object({
  wallLength: z.number().finite().positive(),
  wallHeight: z.number().finite().positive(),
  columnHeight: z.number().finite().gt(300),
});
type Parameters = z.infer<typeof parametersSchema>;
const initialParameters: Parameters = {
  wallLength: 4000,
  wallHeight: 3000,
  columnHeight: 3000,
};
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const guidSchema = z.string().regex(/^[0-3][0-9A-Za-z_$]{21}$/u);
const guidsSchema = z.object({
  wall: guidSchema,
  column: guidSchema,
  storey: guidSchema,
});
const geometrySchema = z.object({
  valid: z.literal(true),
  closed: z.literal(true),
  solids: z.literal(1),
  faces: z.number().int().positive(),
  edges: z.number().int().positive(),
  vertices: z.number().int().positive(),
  volume: z.number().finite().positive(),
  area: z.number().finite().positive(),
  bounds: z.array(z.number().finite()).length(6),
  excessVolume: z.number().finite().nonnegative(),
  missingVolume: z.number().finite().nonnegative(),
  differenceTolerance: z.number().finite().positive(),
});
const objectSchema = z.object({
  name: z.string(),
  typeId: z.string(),
  proxyType: z.string(),
  viewProviderType: z.string(),
  ifcType: z.string().nullable(),
});
const ifcMetadataSchema = z.object({
  path: z.string(),
  sha256: sha256Schema,
  schema: z.literal("IFC4"),
  lengthUnit: z.literal("METRE"),
  scaleFactor: z.literal(0.001),
  storeUid: z.literal(true),
  guids: guidsSchema,
  ifcOpenShellVersion: z.string().regex(/^v?0\.8\./u),
  preferences: z.object({
    SCHEMA: z.literal("IFC4"),
    IFC_UNIT: z.literal("metre"),
    SCALE_FACTOR: z.literal(0.001),
    STORE_UID: z.literal(true),
    ADD_DEFAULT_SITE: z.literal(true),
    ADD_DEFAULT_BUILDING: z.literal(true),
    ADD_DEFAULT_STOREY: z.literal(false),
    EXPORT_2D: z.literal(false),
    FULL_PARAMETRIC: z.literal(false),
    EXPORT_MODEL: z.literal("arch"),
  }),
});
const stageSchema = z.object({
  stage: z.enum(["incoming", "resized"]),
  parameters: parametersSchema,
  geometry: z.object({ wall: geometrySchema, column: geometrySchema }),
  objects: z.object({
    baseline: objectSchema,
    wall: objectSchema,
    column: objectSchema,
    storey: objectSchema,
  }),
  references: z.object({
    wallBase: z.literal("Line"),
    storeyMembers: z.tuple([z.literal("Structure"), z.literal("Wall")]),
    columnToolCount: z.literal(0),
  }),
  baselinePoints: z.array(z.array(z.number().finite()).length(3)).length(2),
  ifc: ifcMetadataSchema,
});
const buildingSchema = z.object({
  capability: z.literal("bim_wall_column_storey"),
  reused: z.boolean(),
  parameters: parametersSchema,
  objects: z.object({
    baseline: z.literal("Line"),
    wall: z.literal("Wall"),
    column: z.literal("Structure"),
    storey: z.literal("BuildingPart"),
  }),
  stages: z.tuple([stageSchema, stageSchema]),
});
const readbackFileSchema = z.object({
  path: z.string(),
  sha256: sha256Schema,
  schema: z.literal("IFC4"),
  lengthUnit: z.literal("METRE"),
  geometryUnit: z.literal("mm"),
  worldCoordinates: z.literal(true),
  serialized: z.literal(true),
  parameters: parametersSchema,
  guids: guidsSchema,
  geometry: z.object({
    wall: geometrySchema.extend({
      type: z.literal("IfcWall"),
      guid: guidSchema,
    }),
    column: geometrySchema.extend({
      type: z.literal("IfcColumn"),
      guid: guidSchema,
    }),
  }),
  spatial: z.object({
    storeyGuid: guidSchema,
    containedGuids: z.array(guidSchema).length(2),
    ancestry: z.tuple([
      z.literal("IfcBuildingStorey"),
      z.literal("IfcBuilding"),
      z.literal("IfcSite"),
      z.literal("IfcProject"),
    ]),
  }),
});
type IfcSpec = Pick<
  z.infer<typeof ifcMetadataSchema>,
  "path" | "sha256" | "guids"
> & {
  parameters: Parameters;
};

async function fixtureSource(file: string, invocation: string) {
  return `${await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8")}\n${invocation}`;
}

function pythonJson(value: unknown) {
  return `__import__('json').loads(${JSON.stringify(JSON.stringify(value))})`;
}

async function buildingSource(options: Record<string, unknown> = {}) {
  return fixtureSource(
    "bim-building.py",
    `result=run_bim_case(${pythonJson(options)})`,
  );
}

async function hashFile(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function checkGeometry(
  geometry: z.infer<typeof stageSchema>["geometry"],
  parameters: Parameters,
) {
  const expected = {
    wall: {
      dimensions: [parameters.wallLength, 200, parameters.wallHeight],
      bounds: [0, -100, 0, parameters.wallLength, 100, parameters.wallHeight],
    },
    column: {
      dimensions: [300, 300, parameters.columnHeight],
      bounds: [4350, 350, 0, 4650, 650, parameters.columnHeight],
    },
  };
  for (const role of ["wall", "column"] as const) {
    const actual = geometry[role],
      [length = NaN, width = NaN, height = NaN] = expected[role].dimensions,
      volume = length * width * height;
    expect(actual.volume).toBeCloseTo(volume, 3);
    expect(actual.area).toBeCloseTo(
      2 * (length * width + length * height + width * height),
      3,
    );
    actual.bounds.forEach((value, index) => {
      expect(value).toBeCloseTo(expected[role].bounds[index] ?? NaN, 6);
    });
    expect(actual.differenceTolerance).toBeCloseTo(
      Math.max(1e-3, volume * 1e-10),
      12,
    );
    expect(actual.excessVolume).toBeLessThanOrEqual(actual.differenceTolerance);
    expect(actual.missingVolume).toBeLessThanOrEqual(
      actual.differenceTolerance,
    );
  }
}

function checkStage(stage: z.infer<typeof stageSchema>, expected: Parameters) {
  expect(stage.parameters).toEqual(expected);
  expect(stage.baselinePoints).toEqual([
    [0, 0, 0],
    [expected.wallLength, 0, 0],
  ]);
  expect(stage.objects).toEqual({
    baseline: {
      name: "Line",
      typeId: "Part::FeaturePython",
      proxyType: "draftobjects.wire.Wire",
      viewProviderType: "draftviewproviders.view_wire.ViewProviderWire",
      ifcType: null,
    },
    wall: {
      name: "Wall",
      typeId: "Part::FeaturePython",
      proxyType: "ArchWall._Wall",
      viewProviderType: "ArchWall._ViewProviderWall",
      ifcType: "Wall",
    },
    column: {
      name: "Structure",
      typeId: "Part::FeaturePython",
      proxyType: "ArchStructure._Structure",
      viewProviderType: "ArchStructure._ViewProviderStructure",
      ifcType: "Column",
    },
    storey: {
      name: "BuildingPart",
      typeId: "App::GeometryPython",
      proxyType: "ArchBuildingPart.BuildingPart",
      viewProviderType: "ArchBuildingPart.ViewProviderBuildingPart",
      ifcType: "Building Storey",
    },
  });
  for (const geometry of Object.values(stage.geometry))
    expect(geometry).toMatchObject({ faces: 6, edges: 12, vertices: 8 });
  checkGeometry(stage.geometry, expected);
}

test.skipIf(nativeUnavailable)(
  "真实BIM墙柱楼层三轮保存重开及参数折返，六个IFC4阶段在独立空文档回读完整几何与空间语义",
  async () =>
    withNativeCad(async (fixture) => {
      let path: string | undefined,
        expected = initialParameters,
        guids: z.infer<typeof guidsSchema> | undefined;
      const protectedFiles = new Map<string, string>(),
        specs: IfcSpec[] = [];
      const rounds: Parameters[] = [
        { wallLength: 5000, wallHeight: 3500, columnHeight: 3200 },
        { wallLength: 3000, wallHeight: 2500, columnHeight: 2800 },
        initialParameters,
      ];
      for (const [index, parameters] of rounds.entries()) {
        const authored = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            ...(path ? { documentPath: path } : {}),
            source: await buildingSource({
              expectedParameters: expected,
              parameters,
            }),
            requireSolids: true,
          },
          `bim-building-round-${index}`,
        );
        expect(authored.isError, JSON.stringify(authored)).not.toBe(true);
        const checked = cadResultSchema.parse(authored.structuredContent),
          data = buildingSchema.parse(checked.data);
        expect(data.reused).toBe(index > 0);
        expect(data.parameters).toEqual(parameters);
        checkStage(data.stages[0], expected);
        checkStage(data.stages[1], parameters);
        for (const stage of data.stages) {
          if (guids) expect(stage.ifc.guids).toEqual(guids);
          else guids = stage.ifc.guids;
          expect(new Set(Object.values(stage.ifc.guids)).size).toBe(3);
          expect(protectedFiles.has(stage.ifc.path)).toBe(false);
          expect(await hashFile(stage.ifc.path)).toBe(stage.ifc.sha256);
          protectedFiles.set(stage.ifc.path, stage.ifc.sha256);
          specs.push({
            path: stage.ifc.path,
            sha256: stage.ifc.sha256,
            guids: stage.ifc.guids,
            parameters: stage.parameters,
          });
        }
        path = z.string().parse(checked.outputPath);
        protectedFiles.set(path, await hashFile(path));
        for (const [file, hash] of protectedFiles)
          expect(await hashFile(file)).toBe(hash);
        expected = parameters;
      }
      expect(expected).toEqual(initialParameters);
      expect(specs).toHaveLength(6);
      // 新 cad_run_python 无 documentPath：独立原生进程与空文档，不复用原 BIM 工程。
      const readback = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          source: await fixtureSource(
            "bim-ifc-readback.py",
            `result=run_bim_ifc_readback(${pythonJson(specs)})`,
          ),
          requireSolids: true,
        },
        "bim-ifc-independent-readback",
      );
      expect(readback.isError, JSON.stringify(readback)).not.toBe(true);
      const checked = cadResultSchema.parse(readback.structuredContent),
        data = z
          .object({
            capability: z.literal("bim_ifc_readback"),
            emptyDocumentAtStart: z.literal(true),
            ifcOpenShellVersion: z.string().regex(/^v?0\.8\./u),
            files: z.array(readbackFileSchema).length(6),
          })
          .parse(checked.data);
      expect(checked.document?.objects).toHaveLength(12);
      for (const [index, file] of data.files.entries()) {
        const spec = specs[index];
        if (!spec) throw new Error("IFC阶段清单缺失");
        expect(file.path).toBe(spec.path);
        expect(file.sha256).toBe(spec.sha256);
        expect(file.parameters).toEqual(spec.parameters);
        expect(file.guids).toEqual(spec.guids);
        expect(file.geometry.wall.guid).toBe(spec.guids.wall);
        expect(file.geometry.column.guid).toBe(spec.guids.column);
        expect(file.spatial.storeyGuid).toBe(spec.guids.storey);
        expect(file.spatial.containedGuids).toEqual(
          [spec.guids.wall, spec.guids.column].sort(),
        );
        checkGeometry(file.geometry, spec.parameters);
      }
      for (const [file, hash] of protectedFiles)
        expect(await hashFile(file)).toBe(hash);
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "BIM无效领域尺寸与缺墙IFC语义明确拒绝，不发布目标且源FCStd和IFC字节保持",
  async () =>
    withNativeCad(async (fixture) => {
      const authored = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        { source: await buildingSource(), requireSolids: true },
        "bim-guards-baseline",
      );
      expect(authored.isError, JSON.stringify(authored)).not.toBe(true);
      const result = cadResultSchema.parse(authored.structuredContent),
        sourcePath = z.string().parse(result.outputPath),
        data = buildingSchema.parse(result.data),
        sourceHash = await hashFile(sourcePath);
      for (const [index, parameters] of [
        { ...initialParameters, wallLength: 0 },
        { ...initialParameters, columnHeight: 300 },
      ].entries()) {
        const outputPath = join(fixture.root, `invalid-bim-${index}.FCStd`),
          rejected = await invokeCadTestTool(
            fixture,
            "cad_run_python",
            {
              documentPath: sourcePath,
              outputPath,
              source: await buildingSource({
                expectedParameters: data.parameters,
                parameters,
              }),
              requireSolids: true,
            },
            `bim-invalid-dimensions-${index}`,
          );
        expect(rejected).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "execution_failed" } },
        });
        expect(JSON.stringify(rejected)).toContain(
          index === 0 ? "BIM 尺寸必须是有限正数" : "结构柱高度必须大于300mm",
        );
        await expect(stat(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await hashFile(sourcePath)).toBe(sourceHash);
      }
      const stage = data.stages[0],
        spec: IfcSpec = {
          path: stage.ifc.path,
          sha256: stage.ifc.sha256,
          guids: stage.ifc.guids,
          parameters: stage.parameters,
        },
        outputPath = join(fixture.root, "missing-ifc-wall.FCStd");
      const rejected = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          outputPath,
          source: await fixtureSource(
            "bim-ifc-readback.py",
            [
              "import os",
              `spec=${pythonJson(spec)}`,
              "damaged=ifcopenshell.open(spec['path'])",
              "damaged.remove(damaged.by_guid(spec['guids']['wall']))",
              "damaged_path=os.path.join(output_directory,'missing-wall.ifc')",
              "damaged.write(damaged_path)",
              "spec['path']=damaged_path",
              "spec['sha256']=_ifc_hash(damaged_path)",
              "result=run_bim_ifc_readback([spec])",
            ].join("\n"),
          ),
          requireSolids: true,
        },
        "bim-ifc-missing-wall",
      );
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "execution_failed" } },
      });
      expect(JSON.stringify(rejected)).toContain("IFC 缺少唯一墙或柱实体语义");
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await hashFile(sourcePath)).toBe(sourceHash);
      for (const stage of data.stages)
        expect(await hashFile(stage.ifc.path)).toBe(stage.ifc.sha256);
    }),
  90_000,
);
