import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { invokeCadTestTool, withNativeCad } from "./test-fixtures.js";
import { cadResultSchema } from "./tool-contracts.js";

const nativeUnavailable =
  process.platform !== "darwin" ||
  process.env.KENFUTWORK_CAD_INTEGRATION !== "1";
const cases = [
  "rotated_rectangle",
  "far_origin_line",
  "circle",
  "circle_arc",
  "ellipse_rotated",
  "ellipse_arc_rotated",
  "bezier_quadratic",
  "bezier_cubic",
  "bspline_cubic",
  "bspline_rational",
  "bspline_degree5",
  "sphere",
  "cylinder",
  "torus",
] as const;
const createdSchema = z
  .object({ objectName: z.string(), view: z.enum(["top", "isometric"]) })
  .passthrough();
const distances = z.object({
  sampleCount: z.literal(129),
  sampledEdgeCount: z.number().int().positive(),
  maxDistance: z.number().finite().nonnegative(),
});
const readbackSchema = z
  .object({
    maxDistance: z.number().finite().nonnegative(),
    expectedToActual: distances,
    actualToExpected: distances,
    expected: z.object({
      valid: z.literal(true),
      bounds: z.array(z.number().finite()).length(6),
      length: z.number().positive(),
      closed: z.boolean(),
    }),
    actual: z.object({
      valid: z.literal(true),
      bounds: z.array(z.number().finite()).length(6),
      length: z.number().positive(),
      closed: z.boolean(),
    }),
  })
  .passthrough();

test.skipIf(nativeUnavailable).each(cases)(
  "SVG精度原生回读：%s",
  async (name) =>
    withNativeCad(async (fixture) => {
      const source = await readFile(
        new URL("./fixtures/svg-roundtrip.py", import.meta.url),
        "utf8",
      );
      const created = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          source: `${source}\nresult=create_svg_case(${JSON.stringify(name)})`,
          requireSolids: ["sphere", "cylinder", "torus"].includes(name),
        },
        `svg-source-${name}`,
      );
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const authored = cadResultSchema.parse(created.structuredContent),
        data = createdSchema.parse(authored.data),
        input = z.string().parse(authored.outputPath);
      const before = await readFile(input);
      const exported = await invokeCadTestTool(
        fixture,
        "cad_export",
        {
          documentPath: input,
          format: "svg",
          objectNames: [data.objectName],
          view: data.view,
        },
        `svg-export-${name}`,
      );
      expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
      const file = cadResultSchema.parse(exported.structuredContent),
        path = z.string().parse(file.outputPath),
        encoding = file.preview?.svgEncoding;
      expect(encoding?.numericPrecision).toBe(17);
      expect(encoding?.edgeCount).toBeGreaterThan(0);
      expect(encoding?.approximationToleranceMm).toBeCloseTo(1e-6, 12);
      if (["bspline_rational", "bspline_degree5"].includes(name))
        expect(encoding?.approximatedEdges.length).toBeGreaterThan(0);
      if (
        ![
          "bspline_rational",
          "bspline_degree5",
          "sphere",
          "cylinder",
          "torus",
        ].some((entry) => entry === name)
      )
        expect(encoding?.approximatedEdges).toEqual([]);
      const bytes = await readFile(path);
      const imported = await invokeCadTestTool(
        fixture,
        "cad_run_python",
        {
          source: `${source}\nresult=read_svg_case(${JSON.stringify(path)},${JSON.stringify(name)})`,
          requireSolids: false,
        },
        `svg-readback-${name}`,
      );
      expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
      const measured = readbackSchema.parse(
        cadResultSchema.parse(imported.structuredContent).data,
      );
      expect(measured.expected.closed).toBe(measured.actual.closed);
      // 原生C2折线容差1e-6，加上SVG导入默认6位小数的坐标舍入及核几何容差。
      expect(
        measured.maxDistance,
        JSON.stringify(measured),
      ).toBeLessThanOrEqual(2e-6);
      for (const axis of [0, 1, 2, 3, 4, 5] as const)
        expect(
          Math.abs(
            (measured.actual.bounds[axis] ?? NaN) -
              (measured.expected.bounds[axis] ?? NaN),
          ),
        ).toBeLessThanOrEqual(3e-6);
      expect(
        Math.abs(measured.actual.length - measured.expected.length),
      ).toBeLessThanOrEqual(0.0001);
      if (["sphere", "cylinder", "torus"].includes(name)) {
        const preview = await invokeCadTestTool(
          fixture,
          "cad_preview",
          { documentPath: input, view: data.view },
          `svg-preview-${name}`,
        );
        expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
        expect(preview.structuredContent).toMatchObject({
          mimeType: "image/png",
          width: 1024,
          height: 768,
        });
      }
      expect(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(await readFile(input)).toEqual(before);
    }),
  90_000,
);
