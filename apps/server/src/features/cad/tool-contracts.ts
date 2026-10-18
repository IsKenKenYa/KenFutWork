import { z } from "zod";

const path = z.string().min(1);
const positive = z.number().finite().positive();
const revolutionAngle = positive
  .max(360)
  .describe("固定旋转角度，单位 deg，取值 (0,360]。");
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
const point2d = z.tuple([z.number().finite(), z.number().finite()]);
const profileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rectangle"),
      name: z.string().min(1),
      width: positive,
      height: positive,
      origin: point2d
        .describe("左下角的固定绝对坐标，默认 [0,0]，单位 mm。")
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("circle"),
      name: z.string().min(1),
      radius: positive,
      center: point2d
        .describe(
          "圆心的固定绝对坐标，默认 [0,0]；不会随其它轮廓改尺寸而移动。",
        )
        .optional(),
    })
    .strict(),
]);
const featureTarget = {
  name: z.string().min(1),
  label: z.string().optional(),
  body: z.string().min(1),
  profile: z.string().min(1),
};
const dressupTarget = {
  name: z.string().min(1),
  label: z.string().optional(),
  body: z.string().min(1),
  base: z.string().min(1),
  edges: z
    .array(z.string().regex(/^Edge[1-9]\d*$/u))
    .min(1)
    .refine(
      (names) => new Set(names).size === names.length,
      "所选边不能重复。",
    ),
};
const patternAxisSchema = z
  .object({
    sketch: z.string().min(1).describe("同一 Body 中位于阵列之前的草图。"),
    axis: z.enum(["H_Axis", "V_Axis", "N_Axis"]),
  })
  .strict();
const patternOccurrences = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647)
  .describe("包含原件的总实例数，遵循 FreeCAD 原生整数范围。");
const patternAngle = positive
  .max(360)
  .describe("正向 Extent 总角度，单位 deg；原生直接赋值范围 (0,360]。");
const patternLength = positive.describe(
  "首个到末个实例的总距离，单位 mm；次数大于1时，间距为 length/(occurrences-1)。",
);
const patternTarget = {
  name: z.string().min(1),
  label: z.string().optional(),
  body: z.string().min(1),
  original: z
    .string()
    .min(1)
    .describe("当前支撑历史中的同 Body Pad、Pocket 或 Revolution。"),
  occurrences: patternOccurrences,
  reversed: z.boolean().optional(),
};
const patternParametersSchema = z
  .object({
    kind: z.literal("set_pattern_parameters"),
    object: z.string().min(1),
    length: patternLength.optional(),
    angle: patternAngle.optional(),
    occurrences: patternOccurrences.optional(),
    reversed: z.boolean().optional(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.length !== undefined && operation.angle !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "不能同时修改线性长度与环形角度。",
      });
    if (
      [
        operation.length,
        operation.angle,
        operation.occurrences,
        operation.reversed,
      ].every((value) => value === undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "至少指定一个阵列参数。",
      });
  });
const pocketOperationSchema = z.discriminatedUnion("mode", [
  z
    .object({
      kind: z.literal("create_pocket"),
      ...featureTarget,
      mode: z.literal("depth"),
      depth: positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_pocket"),
      ...featureTarget,
      mode: z.literal("through_all"),
    })
    .strict(),
]);
const dimensionTarget = {
  kind: z.literal("set_dimension"),
  object: z.string().min(1),
  value: positive,
};
const dimensionOperationSchema = z.discriminatedUnion("dimension", [
  z
    .object({
      ...dimensionTarget,
      profile: z.string().min(1),
      dimension: z.enum(["width", "height"]),
    })
    .strict(),
  z
    .object({
      ...dimensionTarget,
      dimension: z.enum(["length", "depth", "size"]),
    })
    .strict(),
  z
    .object({
      ...dimensionTarget,
      dimension: z.literal("radius"),
      profile: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...dimensionTarget,
      dimension: z.literal("angle"),
      value: revolutionAngle,
    })
    .strict(),
]);
const operationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create_body"),
      name: z.string().min(1),
      label: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_sketch"),
      name: z.string().min(1),
      body: z.string().min(1).optional(),
      label: z.string().optional(),
      supportPad: z
        .string()
        .min(1)
        .describe(
          "将自由孔草图的局部 Z 绑定到同 Body 基础 Pad.Length；必须同时提供 body。",
        )
        .optional(),
      profiles: z
        .array(profileSchema)
        .min(1)
        .superRefine((profiles, ctx) => {
          const names = new Set<string>();
          for (const [index, profile] of profiles.entries()) {
            if (names.has(profile.name))
              ctx.addIssue({
                code: "custom",
                path: [index, "name"],
                message: "同一草图的轮廓名称不能重复",
              });
            names.add(profile.name);
          }
        }),
    })
    .strict()
    .superRefine((operation, ctx) => {
      if (operation.supportPad !== undefined && operation.body === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "supportPad 必须同时指定草图所属 body",
        });
    }),
  z
    .object({
      kind: z.literal("create_pad"),
      ...featureTarget,
      length: positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_revolution"),
      ...featureTarget,
      axis: z.enum(["x", "y"]),
      angle: revolutionAngle,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_fillet"),
      ...dressupTarget,
      radius: positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_chamfer"),
      ...dressupTarget,
      size: positive,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_linear_pattern"),
      ...patternTarget,
      direction: patternAxisSchema,
      length: patternLength,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_polar_pattern"),
      ...patternTarget,
      axis: patternAxisSchema,
      angle: patternAngle,
    })
    .strict(),
  patternParametersSchema,
  z
    .object({
      kind: z.literal("create_boolean"),
      name: z.string().min(1),
      label: z.string().optional(),
      body: z.string().min(1),
      toolBodies: z
        .array(z.string().min(1))
        .min(1)
        .refine(
          (names) => new Set(names).size === names.length,
          "布尔工具 Body 不能重复。",
        ),
      operation: z.enum(["fuse", "cut", "common"]),
    })
    .strict()
    .refine(
      (operation) => !operation.toolBodies.includes(operation.body),
      "布尔工具不能包含目标 Body。",
    ),
  pocketOperationSchema,
  dimensionOperationSchema,
]);
export const cadOperationsInputSchema = z
  .object({
    ...destination,
    operations: z
      .array(operationSchema)
      .min(1)
      .describe(
        "按顺序执行的建模操作；失败不发布输出，源工程保持不变。中间副作用不视为事务回滚。",
      ),
  })
  .strict();

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
  .object({
    documentPath: path.describe("只读入已有的 FCStd 工程。"),
    edges: z
      .object({
        objectName: z.string().min(1),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
        limit: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .default(50),
      })
      .strict()
      .optional(),
  })
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
  | { action: "operations"; input: z.infer<typeof cadOperationsInputSchema> }
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
const edgePageSchema = z
  .object({
    objectName: z.string().min(1),
    coordinateFrame: z.literal("global"),
    unit: z.literal("mm"),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    nextOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    items: z.array(
      z
        .object({
          name: z.string().regex(/^Edge[1-9]\d*$/u),
          curveType: z.string().min(1).nullable(),
          length: z.number().finite().nonnegative(),
          vertices: z.array(
            z.tuple([
              z.number().finite(),
              z.number().finite(),
              z.number().finite(),
            ]),
          ),
          bounds: shapeSchema.shape.bounds,
          closed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
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
  edgePage: edgePageSchema.optional(),
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
