import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProcessSandbox } from "../process-sandbox/service.js";
import { detectFreeCadRuntime } from "./runtime.js";
import { createCadService } from "./service.js";
import { cadTestLimits, createCadTestContext } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

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
