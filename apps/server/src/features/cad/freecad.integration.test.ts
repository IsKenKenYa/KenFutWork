import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../../kernel/types.js";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { detectFreeCadRuntime } from "./runtime.js";
import { type CadService, createCadService } from "./service.js";
import { cadTestLimits, createCadTestContext } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";
import { createCadTools } from "./tools.js";

it.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "真实Task沙箱覆盖参数化、源工程保护、容器与工程图引用、全局坐标及交换物理尺寸",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "kfw-cad-integration-")),
    );
    const sandbox = createProcessSandbox({
      captureRoot: join(root, "capture"),
      network: { allowedDomains: [], deniedDomains: [] },
    });
    const failures: unknown[] = [];
    try {
      const runtime = await detectFreeCadRuntime();
      if (!runtime) throw new Error("显式原生验收要求本机已安装 FreeCAD");
      const { context } = await createCadTestContext(root);
      const service = createCadService({
        sandbox,
        gate: async () => ({ ok: true }),
        detectRuntime: async () => runtime,
        resolveLimits: async () => ({
          limits: cadTestLimits,
          timeoutMs: 30_000,
        }),
      });
      const first = await service.execute(
        {
          action: "python",
          input: {
            source: [
              "import os",
              "for directory in (doc.TransientDir, App.getUserAppDataDir(), App.getUserCachePath(), App.getTempPath()):",
              "    assert directory and os.path.isdir(directory) and os.path.commonpath([os.path.realpath(directory), output_directory]) == output_directory, 'FreeCAD Task目录未隔离'",
              "import Sketcher",
              "body = doc.addObject('PartDesign::Body', 'Body')",
              "sketch = body.newObject('Sketcher::SketchObject', 'Sketch')",
              "circle = sketch.addGeometry(Part.Circle(App.Vector(0,0,0), App.Vector(0,0,1), 10), False)",
              "sketch.addConstraint(Sketcher.Constraint('Diameter', circle, 20))",
              "pad = body.newObject('PartDesign::Pad', 'Pad')",
              "pad.Profile = sketch",
              "pad.Length = 5",
              "body.Tip = pad",
              "doc.recompute()",
              "result = {'radius': sketch.Geometry[0].Radius}",
            ].join("\n"),
            requireSolids: true,
            expectedVolume: { objectName: "Body", value: Math.PI * 500 },
          },
        },
        context,
      );
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(first.structuredContent.data).toEqual({ radius: 10 });
      const originalPath = String(first.structuredContent.outputPath);
      const original = await readFile(originalPath);
      const changed = await service.execute(
        {
          action: "python",
          input: {
            documentPath: originalPath,
            source:
              "doc.getObject('Pad').Length = 10\ndoc.recompute()\ndoc.save()",
            requireSolids: true,
            expectedVolume: { objectName: "Body", value: Math.PI * 1000 },
          },
        },
        { ...context, toolCallId: "change" },
      );
      expect(changed.isError, JSON.stringify(changed)).not.toBe(true);
      expect(await readFile(originalPath)).toEqual(original);
      const exported = await service.execute(
        {
          action: "export",
          input: {
            documentPath: String(changed.structuredContent.outputPath),
            format: "step",
            objectNames: ["Body"],
          },
        },
        { ...context, toolCallId: "export" },
      );
      expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
      expect(
        await readFile(String(exported.structuredContent.outputPath), "utf8"),
      ).toContain("ISO-10303-21");
      const preview = await service.execute(
        {
          action: "preview",
          input: {
            documentPath: originalPath,
            objectNames: ["Body"],
            view: "isometric",
          },
        },
        { ...context, toolCallId: "preview" },
      );
      expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
      expect(preview.structuredContent).toMatchObject({
        mimeType: "image/png",
        preview: { kind: "wireframe", objectNames: ["Body"] },
      });
      expect(
        (await readFile(String(preview.structuredContent.outputPath)))
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      const image = preview.modelContent?.find((item) => item.type === "image");
      if (image?.type !== "image") throw new Error("真实预览未投影给模型");
      expect(JSON.stringify(preview.canonicalOutput)).not.toContain(image.data);
      for (const format of ["svg", "dxf"] as const) {
        const projection = await service.execute(
          {
            action: "export",
            input: {
              documentPath: originalPath,
              format,
              objectNames: ["Body"],
              view: "top",
            },
          },
          { ...context, toolCallId: `export-${format}` },
        );
        expect(projection.isError, JSON.stringify(projection)).not.toBe(true);
        expect(
          await readFile(
            String(projection.structuredContent.outputPath),
            "utf8",
          ),
        ).toContain(format === "svg" ? 'mm" viewBox=' : "\nENTITIES\n");
      }
      const grouped = await service.execute(
        {
          action: "python",
          input: {
            source: [
              "outer = doc.addObject('App::Part', 'Outer')",
              "inner = doc.addObject('App::Part', 'Inner')",
              "outer.addObject(inner)",
              "box = doc.addObject('Part::Box', 'Box')",
              "box.Length, box.Width, box.Height = 10, 20, 30",
              "inner.addObject(box)",
              "outer.Placement.Base = App.Vector(100, 200, 300)",
              "inner.Placement.Base = App.Vector(10, 20, 30)",
              "box.Placement.Base = App.Vector(3, 4, 5)",
              "page = doc.addObject('TechDraw::DrawPage', 'Page')",
              "template = doc.addObject('TechDraw::DrawSVGTemplate', 'Template')",
              "template.Template = App.getResourceDir() + 'Mod/TechDraw/Templates/Default_Template_A4_Landscape.svg'",
              "page.Template = template",
              "view = doc.addObject('TechDraw::DrawViewPart', 'View')",
              "page.addView(view)",
              "view.Source = [box]",
              "view.Direction = App.Vector(0, 0, 1)",
              "doc.recompute()",
              "from PySide import QtCore",
              "loop = QtCore.QEventLoop()",
              "QtCore.QTimer.singleShot(2000, loop.quit)",
              "loop.exec_()",
              "assert len(view.getVisibleEdges()) == 4",
            ].join("\n"),
            requireSolids: true,
            expectedVolume: { objectName: "Box", value: 6000 },
          },
        },
        { ...context, toolCallId: "grouped-drawing" },
      );
      expect(grouped.isError, JSON.stringify(grouped)).not.toBe(true);
      const groupedPath = String(grouped.structuredContent.outputPath);
      const groupPreview = await service.execute(
        {
          action: "preview",
          input: { documentPath: groupedPath, view: "top" },
        },
        { ...context, toolCallId: "group-default-preview" },
      );
      expect(groupPreview.isError, JSON.stringify(groupPreview)).not.toBe(true);
      expect(groupPreview.structuredContent.preview).toMatchObject({
        objectNames: ["Box"],
      });
      const projected = cadResultSchema.shape.preview.parse(
        groupPreview.structuredContent.preview,
      );
      if (!projected) throw new Error("容器模型缺少投影范围回执");
      for (const [index, expected] of [113, 224, 123, 244].entries())
        expect(projected.projectedBounds[index]).toBeCloseTo(expected, 6);
      const brep = await service.execute(
        {
          action: "export",
          input: { documentPath: groupedPath, format: "brep" },
        },
        { ...context, toolCallId: "group-default-brep" },
      );
      expect(brep.isError, JSON.stringify(brep)).not.toBe(true);
      const brepRoundtrip = await service.execute(
        {
          action: "python",
          input: {
            source: `shape = Part.read(${JSON.stringify(String(brep.structuredContent.outputPath))})\nassert abs(shape.BoundBox.XMin - 113) < 1e-6\nassert abs(shape.BoundBox.YMin - 224) < 1e-6\nassert abs(shape.BoundBox.ZMin - 335) < 1e-6\nobj = doc.addObject('Part::Feature', 'Imported')\nobj.Shape = shape`,
            requireSolids: true,
            expectedVolume: { objectName: "Imported", value: 6000 },
          },
        },
        { ...context, toolCallId: "brep-global-roundtrip" },
      );
      expect(brepRoundtrip.isError, JSON.stringify(brepRoundtrip)).not.toBe(
        true,
      );
      for (const format of ["svg", "dxf"] as const) {
        const projected = await service.execute(
          {
            action: "export",
            input: { documentPath: groupedPath, format, view: "top" },
          },
          { ...context, toolCallId: `group-${format}` },
        );
        expect(projected.isError, JSON.stringify(projected)).not.toBe(true);
        const projectedPath = String(projected.structuredContent.outputPath);
        if (format === "svg")
          expect(await readFile(projectedPath, "utf8")).toMatch(
            /width="[\d.eE+-]+mm" height="[\d.eE+-]+mm"/u,
          );
        const imported = await service.execute(
          {
            action: "python",
            input: {
              source: [
                ...(format === "dxf"
                  ? [
                      "prefs = App.ParamGet('User parameter:BaseApp/Preferences/Mod/Draft')",
                      "prefs.SetBool('dxfUseLegacyImporter', False)",
                      "prefs.SetBool('dxfShowDialog', False)",
                    ]
                  : []),
                `import ${format === "svg" ? "importSVG" : "importDXF"} as exchange`,
                `exchange.insert(${JSON.stringify(projectedPath)}, doc.Name)`,
                "doc.recompute()",
                "shapes = [obj.Shape for obj in doc.Objects if hasattr(obj, 'Shape') and not obj.Shape.isNull()]",
                "assert shapes, '交换文件没有导入任何几何'",
                "combined = Part.makeCompound(shapes)",
                "assert len(combined.Edges) >= 4",
                "assert abs(combined.BoundBox.XLength - 10) < 1e-4, combined.BoundBox",
                "assert abs(combined.BoundBox.YLength - 20) < 1e-4, combined.BoundBox",
              ].join("\n"),
            },
          },
          { ...context, toolCallId: `${format}-physical-roundtrip` },
        );
        expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
      }
      const invalid = await service.execute(
        {
          action: "python",
          input: {
            documentPath: originalPath,
            source:
              "doc.getObject('Pad').Length = -1\nbroken = doc.addObject('Part::Feature', 'Broken')\nbroken.Shape = Part.Shape()",
          },
        },
        { ...context, toolCallId: "invalid" },
      );
      expect(invalid).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "execution_failed" } },
      });
      expect(await readFile(originalPath)).toEqual(original);
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await sandbox.close("cad_integration_cleanup");
        if (failures.length === 0)
          await rm(root, { recursive: true, force: true });
        else console.error(`CAD 原生验收诊断目录：${root}`);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "CAD 验收和资源清理均失败。");
  },
  120_000,
);

async function reopenWithGuiAssertions(input: {
  service: CadService;
  context: ToolExecutionContext;
  documentPath: string;
  assertions: string[];
  callId: string;
}) {
  const reopened = await input.service.execute(
    {
      action: "python",
      input: {
        documentPath: input.documentPath,
        source: [
          "import zipfile",
          `with zipfile.ZipFile(${JSON.stringify(input.documentPath)}) as archive:`,
          "    assert 'GuiDocument.xml' in archive.namelist(), '工具保存的FCStd缺少GuiDocument.xml'",
          "import FreeCADGui as Gui",
          "assert App.GuiUp == 1, '重新打开没有创建GUI文档与ViewObject'",
          "assert not Gui.getMainWindow().isVisible(), '离屏序列化不应显示主窗口'",
          ...input.assertions,
        ].join("\n"),
      },
    },
    { ...input.context, toolCallId: input.callId },
  );
  expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
  return cadResultSchema.parse(reopened.structuredContent).data;
}

it.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "离屏官方序列化保存并恢复3D和2D实际ViewObject可见性，保留Tip与体积",
  async () =>
    withNativeCad(async ({ service, context }) => {
      const cylinder = await service.execute(
        {
          action: "python",
          input: {
            source: [
              "import Sketcher",
              "body = doc.addObject('PartDesign::Body', 'Body')",
              "sketch = body.newObject('Sketcher::SketchObject', 'Sketch')",
              "sketch.addGeometry(Part.Circle(App.Vector(0,0,0), App.Vector(0,0,1), 10), False)",
              "pad = body.newObject('PartDesign::Pad', 'Pad')",
              "pad.Profile = sketch",
              "pad.Length = 5",
              "body.Tip = pad",
              "body.Visibility = True",
              "pad.Visibility = True",
              "sketch.Visibility = False",
            ].join("\n"),
            requireSolids: true,
            expectedVolume: { objectName: "Body", value: Math.PI * 500 },
          },
        },
        context,
      );
      expect(cylinder.isError, JSON.stringify(cylinder)).not.toBe(true);
      expect(
        await reopenWithGuiAssertions({
          service,
          context,
          documentPath: String(cylinder.structuredContent.outputPath),
          callId: "gui-reopen-3d",
          assertions: [
            "body, pad, sketch = doc.getObject('Body'), doc.getObject('Pad'), doc.getObject('Sketch')",
            "assert body.Tip == pad",
            "assert abs(body.Shape.Volume - 1570.7963267948965) < 1e-6",
            "assert body.ViewObject is not None and pad.ViewObject is not None and sketch.ViewObject is not None",
            "assert body.ViewObject.Visibility and body.ViewObject.isVisible(), 'Body实际视图应可见'",
            "assert pad.ViewObject.Visibility and pad.ViewObject.isVisible(), 'Pad实际视图应可见'",
            "assert not sketch.ViewObject.Visibility and not sketch.ViewObject.isVisible(), '隐藏草图不应在恢复后显示'",
            "result = {'body_visible': bool(body.ViewObject.isVisible()), 'tip_visible': bool(pad.ViewObject.isVisible()), 'sketch_visible': bool(sketch.ViewObject.isVisible()), 'tip': body.Tip.Name}",
          ],
        }),
      ).toEqual({
        body_visible: true,
        tip_visible: true,
        sketch_visible: false,
        tip: "Pad",
      });
      const drawing = await service.execute(
        {
          action: "python",
          input: {
            source: `${SKETCH_ONLY_SOURCE}\nbody.Visibility = True\nsketch.Visibility = True`,
            requireSolids: false,
          },
        },
        { ...context, toolCallId: "gui-create-2d" },
      );
      expect(drawing.isError, JSON.stringify(drawing)).not.toBe(true);
      expect(
        await reopenWithGuiAssertions({
          service,
          context,
          documentPath: String(drawing.structuredContent.outputPath),
          callId: "gui-reopen-2d",
          assertions: [
            "body, sketch = doc.getObject('Body'), doc.getObject('Sketch')",
            "assert body.Tip is None and body.Shape.isNull() and sketch.Shape.isValid()",
            "assert body.ViewObject is not None and sketch.ViewObject is not None",
            "assert body.ViewObject.Visibility and body.ViewObject.isVisible(), '二维Body视图应可见'",
            "assert sketch.ViewObject.Visibility and sketch.ViewObject.isVisible(), '二维草图实际视图应可见'",
            "result = {'body_visible': bool(body.ViewObject.isVisible()), 'sketch_visible': bool(sketch.ViewObject.isVisible()), 'tip': None}",
          ],
        }),
      ).toEqual({ body_visible: true, sketch_visible: true, tip: null });
      const primitive = await service.execute(
        {
          action: "primitive",
          input: { kind: "box", length: 10, width: 20, height: 30 },
        },
        { ...context, toolCallId: "gui-default-primitive" },
      );
      expect(primitive.isError, JSON.stringify(primitive)).not.toBe(true);
      expect(
        await reopenWithGuiAssertions({
          service,
          context,
          documentPath: String(primitive.structuredContent.outputPath),
          callId: "gui-reopen-default",
          assertions: [
            "obj = doc.getObject('Primitive')",
            "assert obj.ViewObject is not None and abs(obj.Shape.Volume - 6000) < 1e-6",
            "result = {'visible': bool(obj.ViewObject.Visibility), 'scene_visible': bool(obj.ViewObject.isVisible())}",
          ],
        }),
      ).toEqual({ visible: true, scene_visible: true });
    }),
  120_000,
);

const FLANGE_MODEL_SOURCE = [
  "import math, Sketcher",
  "body = doc.addObject('PartDesign::Body', 'Body')",
  "ring = body.newObject('Sketcher::SketchObject', 'RingSketch')",
  "for radius in (40, 15):",
  "    geometry = ring.addGeometry(Part.Circle(App.Vector(0,0,0), App.Vector(0,0,1), radius), False)",
  "    ring.addConstraint(Sketcher.Constraint('Coincident', geometry, 3, -1, 1))",
  "    ring.addConstraint(Sketcher.Constraint('Radius', geometry, radius))",
  "ring.renameConstraint(1, 'OuterRadius')",
  "ring.renameConstraint(3, 'InnerRadius')",
  "pad = body.newObject('PartDesign::Pad', 'Pad')",
  "pad.Profile = ring",
  "pad.Length = 10",
  "body.Tip = pad",
  "doc.recompute()",
  "pad_volume = pad.Shape.Volume",
  "assert ring.DoF == 0 and ring.solve() == 0",
  "assert math.isclose(pad_volume, math.pi * (40**2 - 15**2) * 10, abs_tol=1e-6)",
  "hole = body.newObject('Sketcher::SketchObject', 'HoleSketch')",
  "hole.Placement.Base.z = 10",
  "circle = hole.addGeometry(Part.Circle(App.Vector(30,0,0), App.Vector(0,0,1), 4), False)",
  "hole.addConstraint(Sketcher.Constraint('DistanceX', circle, 3, 30.0))",
  "hole.addConstraint(Sketcher.Constraint('DistanceY', circle, 3, 0.0))",
  "hole.addConstraint(Sketcher.Constraint('Radius', circle, 4.0))",
  "pocket = body.newObject('PartDesign::Pocket', 'Pocket')",
  "pocket.Profile = hole",
  "pocket.Length = 10",
  "body.Tip = pocket",
  "doc.recompute()",
  "pocket_volume = pocket.Shape.Volume",
  "assert math.isclose(pocket_volume, math.pi * (40**2 - 15**2 - 4**2) * 10, abs_tol=1e-6)",
  "pattern = body.newObject('PartDesign::PolarPattern', 'PolarPattern')",
  "pattern.Originals = [pocket]",
  "pattern.Axis = (hole, ['N_Axis'])",
  "pattern.Angle = 360",
  "pattern.Occurrences = 6",
  "body.Tip = pattern",
  "doc.recompute()",
  "assert pattern.Shape.isValid() and len(pattern.Shape.Solids) == 1",
  "assert math.isclose(body.Shape.Volume, math.pi * (40**2 - 15**2 - 6 * 4**2) * 10, abs_tol=1e-6)",
  "for feature in (ring, pad, hole, pocket):",
  "    feature.Visibility = False",
  "body.Visibility = True",
  "pattern.Visibility = True",
  "result = {'pad_volume': pad_volume, 'pocket_volume': pocket_volume, 'volume': body.Shape.Volume, 'occurrences': pattern.Occurrences, 'tip': body.Tip.Name, 'pattern_type': pattern.TypeId}",
].join("\n");

async function callNativeCadTool(
  tools: ToolDefinition[],
  name: string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`缺少真实CAD工具：${name}`);
  const output = z
    .object({ isError: z.boolean().optional(), structuredContent: z.unknown() })
    .parse(await tool.execute(args, context));
  expect(output.isError, JSON.stringify(output)).not.toBe(true);
  return cadResultSchema.parse(output.structuredContent);
}

it.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "KFW原生进阶工具闭环覆盖草图Pad/Pocket/环形阵列、改尺寸保存重开及STEP数值回读",
  async () =>
    withNativeCad(async ({ service, context }) => {
      const tools = createCadTools(service);
      const volume = (radius: number) =>
        Math.PI * (radius ** 2 - 15 ** 2 - 6 * 4 ** 2) * 10;
      const first = await callNativeCadTool(
        tools,
        "cad_run_python",
        {
          source: FLANGE_MODEL_SOURCE,
          requireSolids: true,
          expectedVolume: { objectName: "Body", value: volume(40) },
        },
        { ...context, toolCallId: "advanced-create" },
      );
      expect(first.data).toMatchObject({
        tip: "PolarPattern",
        pattern_type: "PartDesign::PolarPattern",
        occurrences: 6,
      });
      const initial = z
        .object({
          pad_volume: z.number(),
          pocket_volume: z.number(),
          volume: z.number(),
        })
        .parse(first.data);
      expect(initial.pad_volume).toBeCloseTo(
        Math.PI * (40 ** 2 - 15 ** 2) * 10,
        5,
      );
      expect(initial.pocket_volume).toBeCloseTo(
        Math.PI * (40 ** 2 - 15 ** 2 - 4 ** 2) * 10,
        5,
      );
      expect(initial.volume).toBeCloseTo(volume(40), 5);
      const originalPath = String(first.outputPath);
      const originalBytes = await readFile(originalPath);
      const changed = await callNativeCadTool(
        tools,
        "cad_run_python",
        {
          documentPath: originalPath,
          source: [
            "ring = doc.getObject('RingSketch')",
            "ring.setDatum(1, App.Units.Quantity('45 mm'))",
            "doc.recompute()",
            "assert doc.getObject('Body').Tip.Name == 'PolarPattern'",
            "result = {'outer_radius': ring.Geometry[0].Radius, 'tip': doc.getObject('Body').Tip.Name}",
          ].join("\n"),
          requireSolids: true,
          expectedVolume: { objectName: "Body", value: volume(45) },
        },
        { ...context, toolCallId: "advanced-resize" },
      );
      expect(changed.data).toMatchObject({ tip: "PolarPattern" });
      expect(
        z.object({ outer_radius: z.number() }).parse(changed.data).outer_radius,
      ).toBeCloseTo(45, 8);
      expect(changed.outputPath).not.toBe(originalPath);
      expect(await readFile(originalPath)).toEqual(originalBytes);
      const reopened = await callNativeCadTool(
        tools,
        "cad_run_python",
        {
          documentPath: String(changed.outputPath),
          source: [
            "body, pad, pocket, pattern = [doc.getObject(name) for name in ('Body', 'Pad', 'Pocket', 'PolarPattern')]",
            "assert body.Tip == pattern and pattern.TypeId == 'PartDesign::PolarPattern'",
            "assert pad.Profile[0].Name == 'RingSketch' and pocket.Profile[0].Name == 'HoleSketch'",
            "assert pattern.Occurrences == 6 and abs(doc.getObject('RingSketch').Geometry[0].Radius - 45) < 1e-8",
            "assert body.Shape.isValid() and len(body.Shape.Solids) == 1",
            "result = {'tip': body.Tip.Name, 'pad_profile': pad.Profile[0].Name, 'pocket_profile': pocket.Profile[0].Name, 'occurrences': pattern.Occurrences, 'volume': body.Shape.Volume, 'bounds': [body.Shape.BoundBox.XLength, body.Shape.BoundBox.YLength, body.Shape.BoundBox.ZLength]}",
          ].join("\n"),
          requireSolids: true,
          expectedVolume: { objectName: "Body", value: volume(45) },
        },
        { ...context, toolCallId: "advanced-reopen" },
      );
      expect(reopened.data).toMatchObject({
        tip: "PolarPattern",
        pad_profile: "RingSketch",
        pocket_profile: "HoleSketch",
        occurrences: 6,
      });
      const geometry = z
        .object({ volume: z.number(), bounds: z.array(z.number()).length(3) })
        .parse(reopened.data);
      expect(geometry.volume).toBeCloseTo(volume(45), 5);
      for (const [index, expected] of [90, 90, 10].entries())
        expect(geometry.bounds[index]).toBeCloseTo(expected, 6);
      const step = await callNativeCadTool(
        tools,
        "cad_export",
        { documentPath: String(changed.outputPath), format: "step" },
        { ...context, toolCallId: "advanced-step" },
      );
      expect(await readFile(String(step.outputPath), "utf8")).toContain(
        "ISO-10303-21",
      );
      const imported = await callNativeCadTool(
        tools,
        "cad_run_python",
        {
          source: [
            `shape = Part.read(${JSON.stringify(String(step.outputPath))})`,
            "assert not shape.isNull() and shape.isValid() and len(shape.Solids) == 1",
            "obj = doc.addObject('Part::Feature', 'Roundtrip')",
            "obj.Shape = shape",
            "result = {'volume': shape.Volume, 'solids': len(shape.Solids), 'bounds': [shape.BoundBox.XLength, shape.BoundBox.YLength, shape.BoundBox.ZLength]}",
          ].join("\n"),
          requireSolids: true,
          expectedVolume: {
            objectName: "Roundtrip",
            value: volume(45),
            tolerance: 0.001,
          },
        },
        { ...context, toolCallId: "advanced-step-readback" },
      );
      const readback = z
        .object({
          volume: z.number(),
          solids: z.number(),
          bounds: z.array(z.number()).length(3),
        })
        .parse(imported.data);
      expect(readback.solids).toBe(1);
      expect(readback.volume).toBeCloseTo(volume(45), 3);
      for (const [index, expected] of [90, 90, 10].entries())
        expect(readback.bounds[index]).toBeCloseTo(expected, 5);
      expect(await readFile(originalPath)).toEqual(originalBytes);
    }),
  120_000,
);

const SKETCH_ONLY_SOURCE = [
  "import Sketcher",
  "body = doc.addObject('PartDesign::Body', 'Body')",
  "sketch = body.newObject('Sketcher::SketchObject', 'Sketch')",
  "points = [(0,0,0), (10,0,0), (10,20,0), (0,20,0)]",
  "for start, end in zip(points, points[1:] + points[:1]):",
  "    sketch.addGeometry(Part.LineSegment(App.Vector(*start), App.Vector(*end)), False)",
  "body.Tip = None",
  "doc.recompute()",
  "result = {'body_tip': body.Tip.Name if body.Tip else None, 'sketch_valid': sketch.Shape.isValid(), 'geometry_count': sketch.GeometryCount}",
].join("\n");

async function withNativeCad(
  run: (fixture: {
    root: string;
    service: CadService;
    context: ToolExecutionContext;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kfw-cad-native-")));
  const sandbox = createProcessSandbox({
    captureRoot: join(root, "capture"),
    network: { allowedDomains: [], deniedDomains: [] },
  });
  const failures: unknown[] = [];
  try {
    const runtime = await detectFreeCadRuntime();
    if (!runtime) throw new Error("显式原生验收要求本机已安装 FreeCAD");
    const { context } = await createCadTestContext(root);
    const service = createCadService({
      sandbox,
      gate: async () => ({ ok: true }),
      detectRuntime: async () => runtime,
      resolveLimits: async () => ({ limits: cadTestLimits, timeoutMs: 30_000 }),
    });
    await run({ root, service, context });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await sandbox.close("cad_native_integration_cleanup");
      if (failures.length === 0)
        await rm(root, { recursive: true, force: true });
      else console.error(`CAD 原生验收诊断目录：${root}`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "CAD 原生验收和资源清理均失败。");
}

it.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "二维草图Body无Tip允许空聚合，仍保存有效草图并默认导出SVG/DXF和预览",
  async () =>
    withNativeCad(async ({ service, context }) => {
      const created = await service.execute(
        {
          action: "python",
          input: { source: SKETCH_ONLY_SOURCE, requireSolids: false },
        },
        context,
      );
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const result = cadResultSchema.parse(created.structuredContent);
      expect(result.data).toEqual({
        body_tip: null,
        sketch_valid: true,
        geometry_count: 4,
      });
      expect(
        result.document?.objects.find((obj) => obj.name === "Body"),
      ).toMatchObject({
        tip: null,
        shape: { null: true, valid: false, solids: 0, bounds: null },
      });
      expect(
        result.document?.objects.find((obj) => obj.name === "Sketch"),
      ).toMatchObject({
        shape: { null: false, valid: true, solids: 0, edges: 4 },
      });
      const documentPath = String(result.outputPath);
      expect((await readFile(documentPath)).length).toBeGreaterThan(0);
      const described = await service.execute(
        { action: "describe", input: { documentPath } },
        { ...context, toolCallId: "describe-2d" },
      );
      expect(described.isError, JSON.stringify(described)).not.toBe(true);
      const restored = cadResultSchema.parse(described.structuredContent);
      expect(
        restored.document?.objects.find((obj) => obj.name === "Body")?.shape
          ?.bounds,
      ).toBe(null);
      for (const format of ["svg", "dxf"] as const) {
        const exported = await service.execute(
          { action: "export", input: { documentPath, format, view: "top" } },
          { ...context, toolCallId: `2d-${format}` },
        );
        expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
        expect(
          cadResultSchema.parse(exported.structuredContent).preview,
        ).toMatchObject({
          objectNames: ["Sketch"],
          projectedBounds: [0, 0, 10, 20],
        });
        const file = await readFile(
          String(exported.structuredContent.outputPath),
          "utf8",
        );
        expect(file).toContain(
          format === "svg"
            ? 'xmlns="http://www.w3.org/2000/svg"'
            : "\nENTITIES\n",
        );
      }
      const preview = await service.execute(
        { action: "preview", input: { documentPath, view: "top" } },
        { ...context, toolCallId: "2d-preview" },
      );
      expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
      expect(preview.structuredContent.preview).toMatchObject({
        objectNames: ["Sketch"],
        projectedBounds: [0, 0, 10, 20],
      });
      expect(preview.modelContent?.some((item) => item.type === "image")).toBe(
        true,
      );
      expect(
        (await readFile(String(preview.structuredContent.outputPath)))
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
    }),
  60_000,
);

it.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "真实CAD取消停止已就绪Python且不发布FCStd，同Task新signal仍可执行",
  async () =>
    withNativeCad(async ({ root, service, context }) => {
      const controller = new AbortController();
      const readyPath = join(root, "cad-cancel-ready.txt");
      const outputPath = join(root, "cancelled.FCStd");
      const running = service.execute(
        {
          action: "python",
          input: {
            outputPath,
            source: [
              "import time",
              "box = doc.addObject('Part::Box', 'WaitingBox')",
              "doc.recompute()",
              `with open(${JSON.stringify(readyPath)}, 'w') as marker:`,
              "    marker.write('ready')",
              "while True:",
              "    time.sleep(0.05)",
            ].join("\n"),
            requireSolids: true,
          },
        },
        { ...context, signal: controller.signal, toolCallId: "real-cancel" },
      );
      await expect
        .poll(async () => readFile(readyPath, "utf8").catch(() => ""), {
          timeout: 20_000,
          interval: 50,
        })
        .toBe("ready");
      controller.abort();
      expect(await running).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "cancelled" } },
      });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
      const continued = await service.execute(
        {
          action: "primitive",
          input: { kind: "box", length: 10, width: 20, height: 30 },
        },
        {
          ...context,
          signal: new AbortController().signal,
          toolCallId: "after-real-cancel",
        },
      );
      expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
      expect(
        cadResultSchema
          .parse(continued.structuredContent)
          .document?.objects.find((obj) => obj.name === "Primitive")?.shape,
      ).toMatchObject({ valid: true, null: false, volume: 6000 });
      expect(
        (await readFile(String(continued.structuredContent.outputPath))).length,
      ).toBeGreaterThan(0);
    }),
  60_000,
);

it.skipIf(
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1" ||
    process.platform !== "darwin",
)(
  "二维聚合豁免不能放宽requireSolids、普通空Feature、坏Pad或缺Tip实体Body",
  async () =>
    withNativeCad(async ({ service, context }) => {
      const solids = await service.execute(
        {
          action: "python",
          input: { source: SKETCH_ONLY_SOURCE, requireSolids: true },
        },
        { ...context, toolCallId: "2d-needs-solid" },
      );
      expect(solids).toMatchObject({
        isError: true,
        structuredContent: {
          error: { code: "execution_failed", message: "工程没有有效实体" },
        },
      });
      const invalidSources = [
        "doc.addObject('Part::Feature', 'EmptyFeature')",
        "body = doc.addObject('PartDesign::Body', 'EmptyBody')",
        `${SKETCH_ONLY_SOURCE}\npad = body.newObject('PartDesign::Pad', 'BadPad')\npad.Length = 5\nbody.Tip = pad`,
        `${SKETCH_ONLY_SOURCE}\nfeature = body.newObject('PartDesign::Feature', 'SolidFeature')\nfeature.Shape = Part.makeBox(10,20,30)\nbody.Tip = None`,
        `${SKETCH_ONLY_SOURCE}\nempty = body.newObject('Sketcher::SketchObject', 'EmptySketch')`,
      ];
      for (const [index, source] of invalidSources.entries()) {
        const failed = await service.execute(
          { action: "python", input: { source, requireSolids: false } },
          { ...context, toolCallId: `2d-invalid-${index}` },
        );
        expect(failed, source).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "execution_failed" } },
        });
        expect(failed.structuredContent).not.toHaveProperty("outputPath");
      }
    }),
  60_000,
);
