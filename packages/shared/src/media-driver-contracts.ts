import { z } from "zod";
import {
  imageGenerationCapsSchema,
  videoGenerationCapsSchema,
} from "./provider-contracts.js";

const fieldKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .refine(
    (value) => !["constructor", "prototype"].includes(value),
    "请使用普通字段名称",
  );
const parameterValue = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);

const parameterShape = z
  .object({
    key: fieldKey,
    label: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "select", "string-list"]),
    required: z.boolean().optional(),
    default: parameterValue.optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    options: z
      .array(z.object({ label: z.string().min(1), value: z.string() }).strict())
      .min(1)
      .optional(),
  })
  .strict();

function validDefault(field: z.infer<typeof parameterShape>): boolean {
  if (field.default === undefined) return true;
  switch (field.type) {
    case "number":
      return (
        typeof field.default === "number" &&
        (field.min === undefined || field.default >= field.min) &&
        (field.max === undefined || field.default <= field.max)
      );
    case "boolean":
      return typeof field.default === "boolean";
    case "string-list":
      return Array.isArray(field.default);
    case "select":
      return (
        field.options?.some((item) => item.value === field.default) === true
      );
    case "string":
      return typeof field.default === "string";
  }
}

export const mediaDriverParameterSchema = parameterShape.superRefine(
  (field, context) => {
    if (field.type === "select" && !field.options)
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "请选择字段的可用选项",
      });
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    )
      context.addIssue({
        code: "custom",
        path: ["max"],
        message: "最大值不能小于最小值",
      });
    if (!validDefault(field))
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "默认值不符合字段定义",
      });
  },
);

export const mediaDriverConnectionFieldSchema = z
  .object({
    key: fieldKey,
    label: z.string().min(1),
    secret: z.boolean().default(false),
    required: z.boolean().default(false),
    default: z.string().optional(),
  })
  .strict()
  .refine((field) => !field.secret || field.default === undefined, {
    path: ["default"],
    message: "秘密字段请在连接设置中填写",
  });

export const mediaDriverModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    capability: z.enum(["image", "video"]),
    execution: z.enum(["sync", "async"]),
    imageGeneration: imageGenerationCapsSchema.optional(),
    videoGeneration: videoGenerationCapsSchema.optional(),
    parameters: z.array(mediaDriverParameterSchema).default([]),
  })
  .strict();

export const mediaDriverOriginSchema = z
  .url()
  .refine(
    (value) => /^https?:\/\/[^/?#@]+$/.test(value),
    "请填写完整的 HTTP 或 HTTPS 网站地址，不含路径和密钥",
  );

export const mediaDriverManifestSchema = z
  .object({
    apiVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().min(1),
    name: z.string().min(1),
    origins: z.array(mediaDriverOriginSchema).min(1),
    connectionFields: z.array(mediaDriverConnectionFieldSchema).default([]),
    models: z.array(mediaDriverModelSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const checkKeys = (values: string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", path, message: "字段名称不能重复" });
    };
    checkKeys(
      manifest.connectionFields.map((field) => field.key),
      ["connectionFields"],
    );
    checkKeys(
      manifest.models.map((model) => model.id),
      ["models"],
    );
    checkKeys(manifest.origins, ["origins"]);
    manifest.models.forEach((model, index) => {
      checkKeys(
        model.parameters.map((field) => field.key),
        ["models", index, "parameters"],
      );
      if (
        (model.capability === "image" && model.videoGeneration) ||
        (model.capability === "video" && model.imageGeneration)
      )
        context.addIssue({
          code: "custom",
          path: ["models", index],
          message: "模型能力与媒体类型不一致",
        });
    });
  });

export const mediaDriverMethodSchema = z.enum([
  "prepareInputs",
  "submit",
  "query",
  "cancel",
]);
export const mediaDriverPreviewRequestSchema = z
  .object({ source: z.string().min(1) })
  .strict();
export const mediaDriverPreviewResponseSchema = z
  .object({
    manifest: mediaDriverManifestSchema,
    methods: z.array(mediaDriverMethodSchema),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compiledDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceBytes: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
    validation: z.literal("format_only"),
  })
  .strict();

/** 素材仅传宿主签发的引用，脚本不能把本机路径当作素材读取。 */
export const mediaDriverMaterialSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["image", "video", "audio"]),
    role: z.enum(["reference", "first-frame", "last-frame"]),
  })
  .strict();

export const mediaDriverInputSchema = z
  .object({
    capability: z.enum(["image", "video"]),
    model: z.string().min(1),
    prompt: z.string(),
    count: z.number().int().positive(),
    parameters: z.record(z.string(), parameterValue),
    materials: z.array(mediaDriverMaterialSchema),
  })
  .strict();

export const mediaDriverHandleSchema = z.union([
  z.string().min(1),
  z
    .record(z.string(), z.json())
    .refine((value) => Object.keys(value).length > 0),
]);
export const mediaDriverOutputSchema = z
  .object({
    kind: z.enum(["image", "video"]),
    url: z.string().min(1),
    mimeType: z.string().min(1),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    durationSeconds: z.number().nonnegative().optional(),
  })
  .strict();
const succeeded = z
  .object({
    state: z.literal("succeeded"),
    outputs: z.array(mediaDriverOutputSchema).min(1),
  })
  .strict();
const failed = z
  .object({
    state: z.literal("failed"),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        status: z.number().int().min(100).max(599).optional(),
        retryAfter: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export const mediaDriverSubmitResultSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("pending"), handle: mediaDriverHandleSchema })
    .strict(),
  succeeded,
  failed,
]);
export const mediaDriverQueryResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  succeeded,
  failed,
]);

export type MediaDriverManifest = z.infer<typeof mediaDriverManifestSchema>;
export type MediaDriverParameter = z.infer<typeof mediaDriverParameterSchema>;
export type MediaDriverMethod = z.infer<typeof mediaDriverMethodSchema>;
export type MediaDriverPreview = z.infer<
  typeof mediaDriverPreviewResponseSchema
>;
export type MediaDriverInput = z.infer<typeof mediaDriverInputSchema>;
export type MediaDriverMaterial = z.infer<typeof mediaDriverMaterialSchema>;
export type MediaDriverHandle = z.infer<typeof mediaDriverHandleSchema>;
export type MediaDriverOutput = z.infer<typeof mediaDriverOutputSchema>;
export type MediaDriverSubmitResult = z.infer<
  typeof mediaDriverSubmitResultSchema
>;
export type MediaDriverQueryResult = z.infer<
  typeof mediaDriverQueryResultSchema
>;
