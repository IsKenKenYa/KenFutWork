import { z } from "zod";

const path = z.string().min(1);
const positive = z.number().finite().positive();
const destination = {
  documentPath: path
    .describe("只读入已有的 FCStd 工程；新建工程时省略。")
    .optional(),
  outputPath: path
    .describe(
      "必须是新文件路径，由工具最终发布；不要在 source 中先 saveAs 到此目标。",
    )
    .optional(),
};
const cadViewSchema = z.enum(["isometric", "top", "front", "right"]);

export const cadPythonInputSchema = z
  .object({
    ...destination,
    source: z
      .string()
      .min(1)
      .describe(
        "FreeCAD Python。用 output_directory 暂存中间文件或做重开验证，最终保留 doc 交给工具保存；不要先写 outputPath。3D任务设置 requireSolids:true。",
      ),
    requireSolids: z.boolean().optional(),
    expectedVolume: z
      .object({
        objectName: z.string().min(1),
        value: z.number().finite().nonnegative(),
        tolerance: positive.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const cadPrimitiveInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...destination,
      kind: z.literal("box"),
      length: positive,
      width: positive,
      height: positive,
      label: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...destination,
      kind: z.literal("cylinder"),
      radius: positive,
      height: positive,
      label: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...destination,
      kind: z.literal("sphere"),
      radius: positive,
      label: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...destination,
      kind: z.literal("cone"),
      radius: positive,
      radius2: z.number().finite().nonnegative(),
      height: positive,
      label: z.string().optional(),
    })
    .strict(),
]);

export const cadExportInputSchema = z
  .object({
    documentPath: path.describe("只读入已有的 FCStd 工程。"),
    format: z.enum(["step", "stl", "obj", "brep", "svg", "dxf"]),
    objectNames: z.array(z.string().min(1)).min(1).optional(),
    view: cadViewSchema.optional(),
    outputPath: destination.outputPath,
  })
  .strict();
export const cadDescribeInputSchema = z
  .object({ documentPath: path.describe("只读入已有的 FCStd 工程。") })
  .strict();
export const cadPreviewInputSchema = z
  .object({
    documentPath: path.describe("只读入已有的 FCStd 工程。"),
    objectNames: z.array(z.string().min(1)).min(1).optional(),
    view: cadViewSchema.optional(),
    outputPath: destination.outputPath,
  })
  .strict();
export const cadStatusSchema = z.object({}).strict();

export type CadRequest =
  | { action: "describe"; input: z.infer<typeof cadDescribeInputSchema> }
  | { action: "primitive"; input: z.infer<typeof cadPrimitiveInputSchema> }
  | { action: "export"; input: z.infer<typeof cadExportInputSchema> }
  | { action: "preview"; input: z.infer<typeof cadPreviewInputSchema> }
  | { action: "python"; input: z.infer<typeof cadPythonInputSchema> };

const shapeSchema = z.object({
  valid: z.boolean(),
  null: z.boolean(),
  solids: z.number().int().nonnegative(),
  volume: z.number().finite(),
  area: z.number().finite(),
  faces: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  bounds: z.array(z.number().finite()).length(6).nullable(),
});
export const cadResultSchema = z.object({
  protocol: z.literal("kfw-cad/1"),
  executionId: z.string(),
  success: z.boolean(),
  version: z.array(z.string()).optional(),
  document: z
    .object({
      name: z.string(),
      label: z.string(),
      objects: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.string(),
          state: z.array(z.string()),
          properties: z.array(z.string()),
          tip: z.string().nullable().optional(),
          shape: shapeSchema.optional(),
        }),
      ),
    })
    .optional(),
  outputPath: z.string().optional(),
  data: z.json().optional(),
  preview: z
    .object({
      kind: z.literal("wireframe"),
      view: cadViewSchema,
      objectNames: z.array(z.string()),
      projectedBounds: z.array(z.number().finite()).length(4),
    })
    .optional(),
  error: z.string().optional(),
});
export type CadResult = z.infer<typeof cadResultSchema>;
