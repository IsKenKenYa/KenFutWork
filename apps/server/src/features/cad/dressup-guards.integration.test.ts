import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { executeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];
type Operation = Record<string, unknown>;

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
type Mode = (typeof modes)[number];

async function call(
  fixture: NativeCad,
  name: string,
  args: Record<string, unknown>,
  id: string,
) {
  const tool = createCadTools(fixture.service).find(
    (item) => item.name === name,
  );
  if (!tool) throw new Error(`缺少 CAD 工具: ${name}`);
  return executeCadTestTool(tool, args, {
    ...fixture.context,
    toolCallId: id,
  });
}

async function succeed(
  fixture: NativeCad,
  name: string,
  args: Record<string, unknown>,
  id: string,
) {
  const result = await call(fixture, name, args, id);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return cadResultSchema.parse(result.structuredContent);
}

async function refuse(
  fixture: NativeCad,
  documentPath: string,
  operations: Operation[],
  id: string,
  reason?: RegExp,
) {
  const before = await readFile(documentPath);
  const outputPath = join(fixture.root, `${id}.FCStd`);
  const result = await call(
    fixture,
    "cad_apply_operations",
    { documentPath, outputPath, operations },
    id,
  );
  expect(result.isError, JSON.stringify(result)).toBe(true);
  const error = z
    .object({ error: z.object({ code: z.string(), message: z.string() }) })
    .parse(result.structuredContent).error;
  expect(error.code).toBe("execution_failed");
  if (reason) expect(error.message).toMatch(reason);
  await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(documentPath)).toEqual(before);
}

async function fixturePrefix(includeInitialFillet: boolean) {
  const source = await readFile(
    new URL("./fixtures/dressup-selection.py", import.meta.url),
    "utf8",
  );
  const marker = includeInitialFillet
    ? "\ndef inspect_selection("
    : "\ninitial = ";
  const end = source.indexOf(marker);
  if (end < 0) throw new Error("选边夹具缺少稳定的工程构建分界");
  return `doc.UseHasher = False\n${source.slice(0, end)}`;
}

async function creationSeed(fixture: NativeCad, id: string) {
  const result = await succeed(
    fixture,
    "cad_run_python",
    {
      requireSolids: true,
      source: [
        await fixturePrefix(true),
        "other = doc.addObject('PartDesign::Body', 'OtherBody')",
        "other_box = other.newObject('PartDesign::AdditiveBox', 'OtherBox')",
        "other_box.Length, other_box.Width, other_box.Height = 10, 10, 10",
        "marker = doc.addObject('App::DocumentObjectGroup', 'KfwSelectionProbe')",
        "marker.addProperty('App::PropertyString', 'GuardMarker')",
        "marker.GuardMarker = '既有对象必须保留'",
        "doc.recompute()",
        "assert body.Tip is initial and other.Tip is other_box",
        "result = {'sharp': sharp, 'smooth': smooth}",
      ].join("\n"),
    },
    id,
  );
  return {
    path: z.string().min(1).parse(result.outputPath),
    ...z.object({ sharp: z.string(), smooth: z.string() }).parse(result.data),
  };
}

async function editingSeed(fixture: NativeCad, mode: Mode, id: string) {
  const result = await succeed(
    fixture,
    "cad_run_python",
    {
      requireSolids: true,
      source: [
        await fixturePrefix(false),
        `feature = body.newObject(${JSON.stringify(mode.type)}, 'Dressed')`,
        "feature.Base = (box, [vertical_edge(box, 10, 10)])",
        "feature.UseAllEdges = False",
        ...(mode.dimension === "size"
          ? ["feature.ChamferType = 'Equal distance'"]
          : []),
        `feature.${mode.parameter} = 0.5`,
        "body.Tip = feature",
        "sketch = doc.addObject('Sketcher::SketchObject', 'GuardSketch')",
        "sketch.addGeometry(Part.Circle(App.Vector(0,0,0), App.Vector(0,0,1), 2), False)",
        "doc.recompute()",
        "assert feature.getStatusString() == 'Valid' and len(feature.Shape.Solids) == 1",
      ].join("\n"),
    },
    id,
  );
  return z.string().min(1).parse(result.outputPath);
}

async function changedSource(
  fixture: NativeCad,
  documentPath: string,
  lines: string[],
  id: string,
) {
  const before = await readFile(documentPath);
  const result = await succeed(
    fixture,
    "cad_run_python",
    {
      documentPath,
      requireSolids: true,
      source: [
        "feature = doc.getObject('Dressed')",
        ...lines,
        "doc.recompute()",
        "assert feature.getStatusString() == 'Valid'",
      ].join("\n"),
    },
    id,
  );
  expect(await readFile(documentPath)).toEqual(before);
  return z.string().min(1).parse(result.outputPath);
}

function edit(mode: Mode): Operation {
  return {
    kind: "set_dimension",
    object: "Dressed",
    dimension: mode.dimension,
    value: 1,
  };
}

describe("显式边圆角／等距倒角的创建边界", () => {
  test.skipIf(nativeUnavailable).each(modes)(
    "$kind拒绝错误选择和基体且不删除碰撞的既有probe对象",
    async (mode) =>
      withNativeCad(async (fixture) => {
        const seed = await creationSeed(
          fixture,
          `${mode.dimension}-guard-seed`,
        );
        const original = await readFile(seed.path);
        const operation = {
          kind: mode.kind,
          name: "Dressed",
          body: "Body",
          base: "InitialFillet",
          edges: [seed.sharp],
          [mode.dimension]: 0.5,
        };
        const cases: [string, Operation, RegExp | undefined][] = [
          ["missing-edge", { edges: ["Edge999"] }, /基体边不存在/],
          ["out-of-range-edge", { edges: ["Edge2147483647"] }, /基体边不存在/],
          ["missing-base", { base: "MissingBase" }, /当前实体 Tip/],
          ["wrong-body", { body: "OtherBody" }, /当前实体 Tip/],
          ["stale-base", { base: "Box" }, /当前实体 Tip/],
          ["name-collision", { name: "InitialFillet" }, /名称已存在/],
          ["oversized", { [mode.dimension]: 1_000_000 }, undefined],
          ["mixed-edges", { edges: [seed.sharp, seed.smooth] }, /未接纳所选边/],
          ["smooth-only", { edges: [seed.smooth] }, /未接纳所选边/],
        ];
        for (const [name, changes, reason] of cases) {
          await refuse(
            fixture,
            seed.path,
            [{ ...operation, ...changes }],
            `${mode.dimension}-${name}`,
            reason,
          );
        }
        const created = await succeed(
          fixture,
          "cad_apply_operations",
          { documentPath: seed.path, operations: [operation] },
          `${mode.dimension}-probe-name-collision-success`,
        );
        const createdPath = z.string().min(1).parse(created.outputPath);
        const createdBytes = await readFile(createdPath);
        const inspected = await succeed(
          fixture,
          "cad_run_python",
          {
            documentPath: createdPath,
            requireSolids: true,
            source: [
              "marker = doc.getObject('KfwSelectionProbe')",
              "assert marker is not None and marker.TypeId == 'App::DocumentObjectGroup'",
              "assert marker.GuardMarker == '既有对象必须保留'",
              "assert [obj.Name for obj in doc.Objects if obj.Name.startswith('KfwSelectionProbe')] == ['KfwSelectionProbe']",
              "body, feature = doc.getObject('Body'), doc.getObject('Dressed')",
              "assert body.Tip is feature and feature.BaseFeature is doc.getObject('InitialFillet')",
              "assert feature.getStatusString() == 'Valid' and len(feature.Shape.Solids) == 1",
              "result = {'originalProbeRetained': True, 'temporaryProbesRemoved': True}",
            ].join("\n"),
          },
          `${mode.dimension}-probe-name-readback`,
        );
        expect(inspected.data).toEqual({
          originalProbeRetained: true,
          temporaryProbesRemoved: true,
        });
        expect(await readFile(seed.path)).toEqual(original);
        expect(await readFile(createdPath)).toEqual(createdBytes);
      }),
    180_000,
  );
});

describe("圆角／等距倒角的原生编辑保护", () => {
  test.skipIf(nativeUnavailable).each(modes)(
    "$kind拒绝表达式、全边模式、错误尺寸入口和过大尺寸",
    async (mode) =>
      withNativeCad(async (fixture) => {
        const seed = await editingSeed(
          fixture,
          mode,
          `${mode.dimension}-edit-seed`,
        );
        await refuse(
          fixture,
          seed,
          [{ ...edit(mode), value: 1_000_000 }],
          `${mode.dimension}-edit-oversized`,
        );
        const expression = await changedSource(
          fixture,
          seed,
          [
            `feature.setExpression(${JSON.stringify(mode.parameter)}, '0.5 mm')`,
          ],
          `${mode.dimension}-expression-source`,
        );
        await refuse(
          fixture,
          expression,
          [edit(mode)],
          `${mode.dimension}-expression-refused`,
          /已有表达式/,
        );
        const allEdges = await changedSource(
          fixture,
          seed,
          ["feature.UseAllEdges = True"],
          `${mode.dimension}-all-edges-source`,
        );
        await refuse(
          fixture,
          allEdges,
          [edit(mode)],
          `${mode.dimension}-all-edges-refused`,
          /仅支持显式选边/,
        );
        if (mode.dimension === "size") {
          const unequal = await changedSource(
            fixture,
            seed,
            ["feature.ChamferType = 'Two distances'", "feature.Size2 = 0.75"],
            "size-unequal-source",
          );
          await refuse(
            fixture,
            unequal,
            [edit(mode)],
            "size-unequal-refused",
            /仅支持等距倒角/,
          );
        } else {
          await refuse(
            fixture,
            seed,
            [
              {
                kind: "set_dimension",
                object: "GuardSketch",
                dimension: "radius",
                value: 1,
              },
            ],
            "sketch-radius-without-profile",
            /尺寸对象类型不匹配/,
          );
          await refuse(
            fixture,
            seed,
            [{ ...edit(mode), profile: "Circle" }],
            "fillet-radius-with-profile",
            /不存在或不是草图/,
          );
        }
      }),
    180_000,
  );

  const protectedCases = modes.flatMap((mode) =>
    (["ReadOnly", "Immutable"] as const).map((flag) => ({ ...mode, flag })),
  );
  test.skipIf(nativeUnavailable).for(protectedCases)(
    "$kind原生$flag属性保存重开后拒绝直接改尺寸",
    { timeout: 90_000 },
    async (mode, context) => {
      let missingPersistence: string | undefined;
      await withNativeCad(async (fixture) => {
        const id = `${mode.dimension}-${mode.flag}`;
        const seed = await editingSeed(fixture, mode, `${id}-seed`);
        const protectedPath = await changedSource(
          fixture,
          seed,
          [
            mode.flag === "ReadOnly"
              ? `feature.setEditorMode(${JSON.stringify(mode.parameter)}, 1)`
              : `feature.setPropertyStatus(${JSON.stringify(mode.parameter)}, 'Immutable')`,
            mode.flag === "ReadOnly"
              ? `assert 'ReadOnly' in feature.getEditorMode(${JSON.stringify(mode.parameter)})`
              : `assert 'Immutable' in feature.getPropertyStatus(${JSON.stringify(mode.parameter)})`,
          ],
          `${id}-source`,
        );
        const before = await readFile(protectedPath);
        const reopened = await succeed(
          fixture,
          "cad_run_python",
          {
            documentPath: protectedPath,
            requireSolids: true,
            source: [
              "feature = doc.getObject('Dressed')",
              `editor = feature.getEditorMode(${JSON.stringify(mode.parameter)})`,
              `status = feature.getPropertyStatus(${JSON.stringify(mode.parameter)})`,
              "result = {'readOnly': 'ReadOnly' in editor or 'ReadOnly' in status, 'immutable': 'Immutable' in status}",
            ].join("\n"),
          },
          `${id}-reopened`,
        );
        expect(await readFile(protectedPath)).toEqual(before);
        const observed = z
          .object({ readOnly: z.boolean(), immutable: z.boolean() })
          .parse(reopened.data);
        const persisted =
          mode.flag === "ReadOnly" ? observed.readOnly : observed.immutable;
        if (!persisted) {
          missingPersistence = `${mode.type}.${mode.parameter} 的原生 ${mode.flag} 未跨 FCStd 保存重开保留；本项未执行结构化拒绝验收，不能记作通过。`;
          return;
        }
        await refuse(
          fixture,
          protectedPath,
          [edit(mode)],
          `${id}-refused`,
          mode.flag === "ReadOnly" ? /只读属性/ : /不可修改/,
        );
      });
      if (missingPersistence) context.skip(missingPersistence);
    },
  );
});

test.skipIf(nativeUnavailable).each(modes)(
  "$kind拒绝真实Sphere退化边且不发布新工程",
  async (mode) =>
    withNativeCad(async (fixture) => {
      const seed = await succeed(
        fixture,
        "cad_run_python",
        {
          requireSolids: true,
          source: [
            "body = doc.addObject('PartDesign::Body','Body')",
            "sphere = body.newObject('PartDesign::AdditiveSphere','Sphere')",
            "sphere.Radius = 5",
            "doc.recompute()",
            "edges = ['Edge' + str(i) for i,edge in enumerate(sphere.Shape.Edges,1) if edge.Degenerated]",
            "assert len(edges) == 2",
            "result = {'edge':edges[0]}",
          ].join("\n"),
        },
        `${mode.dimension}-degenerate-seed`,
      );
      const edge = z.object({ edge: z.string() }).parse(seed.data).edge;
      await refuse(
        fixture,
        z.string().parse(seed.outputPath),
        [
          {
            kind: mode.kind,
            name: "Dressed",
            body: "Body",
            base: "Sphere",
            edges: [edge],
            [mode.dimension]: 0.5,
          },
        ],
        `${mode.dimension}-degenerate-refused`,
        /有效非退化边/,
      );
    }),
  60_000,
);
