import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { invokeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

type NativeCad = Parameters<Parameters<typeof withNativeCad>[0]>[0];
const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";

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

test.skipIf(nativeUnavailable)(
  "FEM的Shape链接不被当作TopoShape，保存重开仍保留真实几何与链接",
  async () =>
    withNativeCad(async (fixture) => {
      const created = await call(
        fixture,
        "cad_run_python",
        {
          source: [
            "import ObjectsFem",
            "box=doc.addObject('Part::Box','Box')",
            "box.Length,box.Width,box.Height=100,10,10",
            "mesh=ObjectsFem.makeMeshGmsh(doc,'Mesh')",
            "mesh.Shape=box",
            "doc.recompute()",
            "assert mesh.getTypeIdOfProperty('Shape')=='App::PropertyLink'",
            "result={'shapePropertyType':mesh.getTypeIdOfProperty('Shape'),'meshNodes':mesh.FemMesh.NodeCount}",
          ].join("\n"),
          requireSolids: true,
        },
        "fem-shape-link-create",
      );
      expect(created.data).toEqual({
        shapePropertyType: "App::PropertyLink",
        meshNodes: 0,
      });
      expect(
        created.document?.objects.find((obj) => obj.name === "Mesh")?.shape,
      ).toBeUndefined();
      expect(
        created.document?.objects.find((obj) => obj.name === "Box")?.shape
          ?.volume,
      ).toBeCloseTo(10000, 6);
      const path = z.string().parse(created.outputPath);
      const before = await readFile(path);
      const described = await call(
        fixture,
        "cad_describe_document",
        { documentPath: path },
        "fem-shape-link-describe",
      );
      expect(
        described.document?.objects.find((obj) => obj.name === "Mesh")?.shape,
      ).toBeUndefined();
      await call(
        fixture,
        "cad_run_python",
        {
          documentPath: path,
          source: "assert doc.getObject('Mesh').Shape is doc.getObject('Box')",
          requireSolids: true,
        },
        "fem-shape-link-reopened",
      );
      const wrongVolume = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          documentPath: path,
          outputPath: join(fixture.root, "wrong-volume.FCStd"),
          source: "result = None",
          expectedVolume: { objectName: "Mesh", value: 10000 },
        },
        "fem-link-volume-rejected",
      );
      expect(wrongVolume).toMatchObject({ isError: true });
      expect(JSON.stringify(wrongVolume)).toContain(
        "体积检查对象不存在或没有几何",
      );
      await expect(
        stat(join(fixture.root, "wrong-volume.FCStd")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const exported = await call(
        fixture,
        "cad_export",
        { documentPath: path, format: "step" },
        "fem-link-default-export",
      );
      const exchange = z.string().parse(exported.outputPath);
      await call(
        fixture,
        "cad_run_python",
        {
          source: [
            "exchanged = doc.addObject('Part::Feature', 'Exchanged')",
            `exchanged.Shape = Part.read(${JSON.stringify(exchange)})`,
            "assert len(exchanged.Shape.Solids) == 1",
          ].join("\n"),
          expectedVolume: { objectName: "Exchanged", value: 10000 },
          requireSolids: true,
        },
        "fem-link-export-roundtrip",
      );
      const invalidExport = await invokeCadTestTool(
        fixture,
        "cad_export",
        {
          documentPath: path,
          format: "step",
          objectNames: ["Mesh"],
          outputPath: join(fixture.root, "mesh-link.step"),
        },
        "fem-link-explicit-export-rejected",
      );
      expect(invalidExport).toMatchObject({ isError: true });
      expect(JSON.stringify(invalidExport)).toContain(
        "导出对象不存在或没有有效几何",
      );
      await expect(
        stat(join(fixture.root, "mesh-link.step")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path)).toEqual(before);
    }),
  60_000,
);

const femDataSchema = z
  .object({
    fixture: z.literal("fem-axial-pressure"),
    fixtureStatus: z.literal("passed"),
    runId: z.string().regex(/^[a-f0-9]{32}$/u),
    options: z.object({
      length: z.number(),
      pressure: z.number(),
      reversed: z.boolean(),
      meshSize: z.number(),
    }),
    counts: z.object({
      node: z.number().int().positive(),
      volumeElement: z.number().int().positive(),
      resultNode: z.number().int().positive(),
      resultMeshNode: z.number().int().positive(),
    }),
    arrayValidation: z.object({
      finite: z.literal(true),
      matchingLengths: z.literal(true),
      completeNodeCoverage: z.literal(true),
    }),
    analytical: z.object({
      relativeTolerance: z.literal(0.01),
      relativeErrors: z.record(z.string(), z.number().finite()),
      freeEndMeanUx: z.number().finite(),
    }),
    paths: z.object({
      runDirectory: z.string(),
      gmshDirectory: z.string(),
      ccxDirectory: z.string(),
      report: z.string(),
      inp: z.string(),
      frd: z.string(),
      unv: z.string(),
    }),
    processes: z.record(
      z.string(),
      z.object({
        binary: z.string(),
        exitCode: z.literal(0),
        stdout: z.string(),
        stderr: z.string(),
        cwd: z.string(),
        ompNumThreads: z.literal(1),
      }),
    ),
    resultData: z
      .object({
        nodeNumbers: z.array(z.number().int()),
        positions: z.array(
          z.tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ]),
        ),
        displacement: z.array(
          z.tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ]),
        ),
        sxx: z.array(z.number().finite()),
        vonMises: z.array(z.number().finite()),
      })
      .passthrough(),
  })
  .passthrough();

function checkAnalyticalField(
  raw: unknown,
  length: number,
  pressure: number,
  reversed = false,
) {
  const data = femDataSchema.parse(raw);
  const rows = data.resultData;
  expect(data.options).toEqual({ length, pressure, reversed, meshSize: 5 });
  expect(rows.nodeNumbers).toHaveLength(data.counts.node);
  expect(new Set(rows.nodeNumbers).size).toBe(data.counts.node);
  for (const values of [
    rows.positions,
    rows.displacement,
    rows.sxx,
    rows.vonMises,
  ])
    expect(values).toHaveLength(data.counts.node);
  expect(data.counts.resultMeshNode).toBe(data.counts.node);
  const signed = reversed ? pressure : -pressure,
    expectedTip = (signed * length) / 210000;
  const errors: number[] = [];
  for (let i = 0; i < data.counts.node; i++) {
    const p = rows.positions[i],
      u = rows.displacement[i],
      sxx = rows.sxx[i],
      vm = rows.vonMises[i];
    if (!p || !u || sxx === undefined || vm === undefined)
      throw new Error("缺少FEM节点数据");
    expect(p[0]).toBeGreaterThanOrEqual(-1e-7);
    expect(p[0]).toBeLessThanOrEqual(length + 1e-7);
    errors.push(
      Math.abs(u[0] - (signed * p[0]) / 210000) / Math.abs(expectedTip),
      Math.abs(u[1]) / Math.abs(expectedTip),
      Math.abs(u[2]) / Math.abs(expectedTip),
      Math.abs(sxx - signed) / pressure,
      Math.abs(vm - pressure) / pressure,
    );
  }
  expect(Math.max(...errors)).toBeLessThanOrEqual(0.01);
  expect(
    Math.abs(data.analytical.freeEndMeanUx / expectedTip - 1),
  ).toBeLessThanOrEqual(0.01);
  expect(
    Math.max(...Object.values(data.analytical.relativeErrors)),
  ).toBeLessThanOrEqual(0.01);
  return data;
}

async function femSource(options: Record<string, unknown>) {
  const fixture = await readFile(
    new URL("./fixtures/fem-axial-pressure.py", import.meta.url),
    "utf8",
  );
  return `${fixture}\nresult=run_axial_case(json.loads(${JSON.stringify(JSON.stringify(options))}))`;
}

test.skipIf(nativeUnavailable)(
  "FEM真实新网格与CalculiX求解经KFW工具交付，并以完整节点场核对解析值",
  async () =>
    withNativeCad(async (fixture) => {
      const authored = await call(
        fixture,
        "cad_run_python",
        {
          source: await femSource({
            length: 100,
            pressure: 1,
            reversed: false,
            meshSize: 5,
          }),
          requireSolids: true,
        },
        "fem-axial-initial",
      );
      const data = checkAnalyticalField(authored.data, 100, 1);
      expect(Object.keys(data.processes).sort()).toEqual(["ccx", "gmsh"]);
      const { stat, realpath } = await import("node:fs/promises");
      for (const path of [
        data.paths.inp,
        data.paths.frd,
        data.paths.unv,
        data.paths.report,
      ]) {
        expect(path.startsWith(`${fixture.root}/`)).toBe(true);
        expect(await realpath(path)).toBe(path);
        expect((await stat(path)).size).toBeGreaterThan(0);
      }
      expect(
        JSON.parse(await readFile(data.paths.report, "utf8")),
      ).toMatchObject({ fixtureStatus: "passed", runId: data.runId });
      const path = z.string().parse(authored.outputPath);
      const before = await readFile(path);
      const checked = await call(
        fixture,
        "cad_describe_document",
        { documentPath: path },
        "fem-axial-initial-reopened",
      );
      expect(
        checked.document?.objects.find((obj) => obj.name === "Box")?.shape
          ?.volume,
      ).toBeCloseTo(10000, 6);
      expect(
        checked.document?.objects.some(
          (obj) => obj.type === "Fem::FemResultObjectPython",
        ),
      ).toBe(true);
      const resultName = z
        .array(z.string())
        .min(1)
        .parse(data.resultObjects)
        .at(-1);
      const restored = await call(
        fixture,
        "cad_run_python",
        {
          documentPath: path,
          source: [
            `value=doc.getObject(${JSON.stringify(resultName)})`,
            "assert value.isDerivedFrom('Fem::FemResultObject')",
            "assert doc.getObject('MeshGmsh').Shape is doc.getObject('Box')",
            "result={'nodeNumbers':list(value.NodeNumbers),'displacement':[[u.x,u.y,u.z] for u in value.DisplacementVectors],'sxx':list(value.NodeStressXX),'vonMises':list(value.vonMises)}",
          ].join("\n"),
          requireSolids: true,
        },
        "fem-axial-result-roundtrip",
      );
      expect(restored.data).toEqual({
        nodeNumbers: data.resultData.nodeNumbers,
        displacement: data.resultData.displacement,
        sxx: data.resultData.sxx,
        vonMises: data.resultData.vonMises,
      });
      expect(await readFile(path)).toEqual(before);
    }),
  90_000,
);

test.skipIf(nativeUnavailable)(
  "FEM尺寸、载荷和方向改变后生成新网格与新结果，可回绕原参数且不覆盖输入工程",
  async () =>
    withNativeCad(async (fixture) => {
      const seenRuns = new Set<string>(),
        seenFrd = new Set<string>();
      let sourcePath: string | undefined;
      for (const [index, options] of [
        { length: 100, pressure: 1, reversed: false, meshSize: 5 },
        { length: 200, pressure: 2, reversed: true, meshSize: 5 },
        { length: 100, pressure: 1, reversed: false, meshSize: 5 },
      ].entries()) {
        const bytes = sourcePath ? await readFile(sourcePath) : undefined;
        const solved = await call(
          fixture,
          "cad_run_python",
          {
            ...(sourcePath ? { documentPath: sourcePath } : {}),
            source: await femSource(options),
            requireSolids: true,
          },
          `fem-parameter-round-${index}`,
        );
        const data = checkAnalyticalField(
          solved.data,
          options.length,
          options.pressure,
          options.reversed,
        );
        expect(seenRuns.has(data.runId)).toBe(false);
        expect(seenFrd.has(data.paths.frd)).toBe(false);
        seenRuns.add(data.runId);
        seenFrd.add(data.paths.frd);
        if (sourcePath) expect(await readFile(sourcePath)).toEqual(bytes);
        expect(
          solved.document?.objects.find((obj) => obj.name === "Box")?.shape
            ?.volume,
        ).toBeCloseTo(options.length * 100, 6);
        sourcePath = z.string().parse(solved.outputPath);
      }
      expect(seenRuns.size).toBe(3);
      expect(seenFrd.size).toBe(3);
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "FEM缺材料、空载荷引用或本次FRD缺失均拒绝交付，已有结果不能冒充新求解",
  async () =>
    withNativeCad(async (fixture) => {
      const baseline = await call(
        fixture,
        "cad_run_python",
        { source: await femSource({}), requireSolids: true },
        "fem-failure-baseline",
      );
      const sourcePath = z.string().parse(baseline.outputPath);
      const bytes = await readFile(sourcePath);
      const fixtureSource = await readFile(
        new URL("./fixtures/fem-axial-pressure.py", import.meta.url),
        "utf8",
      );
      const cases = [
        {
          name: "missing-material",
          injection: [
            "_original_model = _model",
            "def _model(options, report):",
            "    values = _original_model(options, report)",
            "    values[0].removeObject(doc.getObject('MaterialSolid'))",
            "    return values",
          ],
          error: /[Mm]aterial/u,
        },
        {
          name: "empty-pressure-reference",
          injection: [
            "_original_model = _model",
            "def _model(options, report):",
            "    values = _original_model(options, report)",
            "    doc.getObject('ConstraintPressure').References = []",
            "    return values",
          ],
          error: /[Rr]eference|DLOAD/u,
        },
        {
          name: "missing-new-frd",
          injection: [
            "_original_process = _process",
            "def _process(name, argv, cwd, report, root):",
            "    logs = _original_process(name, argv, cwd, report, root)",
            "    if name == 'ccx':",
            "        os.unlink(report['paths']['frd'])",
            "    return logs",
          ],
          error: /CalculiX 未生成新 FRD/u,
        },
      ];
      for (const item of cases) {
        const outputPath = join(fixture.root, `${item.name}.FCStd`);
        const rejected = await invokeCadTestTool(
          fixture,
          "cad_run_python",
          {
            documentPath: sourcePath,
            outputPath,
            requireSolids: true,
            source: [
              fixtureSource,
              ...item.injection,
              "result = run_axial_case()",
            ].join("\n"),
          },
          `fem-${item.name}`,
        );
        expect(rejected).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "execution_failed" } },
        });
        expect(JSON.stringify(rejected)).toMatch(item.error);
        await expect(stat(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(sourcePath)).toEqual(bytes);
      }
    }),
  120_000,
);

test.skipIf(nativeUnavailable)(
  "Task取消停止已实际启动的Gmsh子进程及FreeCAD，且不发布目标工程",
  async () =>
    withNativeCad(async (fixture) => {
      const readyPath = join(fixture.root, "gmsh-ready.txt");
      const pidPath = join(fixture.root, "fem-processes.json");
      const outputPath = join(fixture.root, "cancelled-fem.FCStd");
      const controller = new AbortController();
      const geo = `Printf("ready") > ${JSON.stringify(readyPath)};\nSleep 60;\n`;
      const running = invokeCadTestTool(
        {
          ...fixture,
          context: { ...fixture.context, signal: controller.signal },
        },
        "cad_run_python",
        {
          outputPath,
          requireSolids: true,
          source: [
            "import json, os, subprocess",
            "box = doc.addObject('Part::Box', 'WaitingBox')",
            "doc.recompute()",
            "geo_path = os.path.join(output_directory, 'cancel.geo')",
            `with open(geo_path, 'w') as stream: stream.write(${JSON.stringify(geo)})`,
            "gmsh = os.path.join(App.getHomePath(), 'bin', 'gmsh')",
            "child = subprocess.Popen([gmsh, '-0', '-v', '3', geo_path], cwd=output_directory)",
            `with open(${JSON.stringify(pidPath)}, 'w') as stream:`,
            "    json.dump({'freecad': os.getpid(), 'gmsh': child.pid}, stream)",
            "child.wait(timeout=25)",
          ].join("\n"),
        },
        "fem-cancel-gmsh",
      );
      try {
        // 由真实 Gmsh 解析器写 marker，不能把 Popen 返回当作程序已运行。
        await expect
          .poll(() => readFile(readyPath, "utf8").catch(() => ""), {
            timeout: 20_000,
            interval: 50,
          })
          .toContain("ready");
        const pids = z
          .object({
            freecad: z.number().int().positive(),
            gmsh: z.number().int().positive(),
          })
          .parse(JSON.parse(await readFile(pidPath, "utf8")));
        for (const pid of Object.values(pids))
          expect(() => process.kill(pid, 0)).not.toThrow();
        controller.abort();
        expect(await running).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "cancelled" } },
        });
        for (const pid of Object.values(pids))
          expect(() => process.kill(pid, 0)).toThrow(
            expect.objectContaining({ code: "ESRCH" }),
          );
        await expect(stat(outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        controller.abort();
        await running;
      }
    }),
  60_000,
);
