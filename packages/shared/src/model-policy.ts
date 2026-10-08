import { z } from "zod";

/** 模型身份独立于能力、显示名称与供应商协议。 */
export const modelReferenceSchema = z
  .object({ providerId: z.uuid().toLowerCase(), modelId: z.string().min(1) })
  .strict();
export type ModelReference = z.infer<typeof modelReferenceSchema>;

export const generationModelPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z
    .object({
      mode: z.literal("manual"),
      models: z
        .array(modelReferenceSchema)
        .min(1)
        .refine(
          (models) =>
            new Set(
              models.map((model) =>
                JSON.stringify([model.providerId, model.modelId]),
              ),
            ).size === models.length,
          "候选模型不能重复。",
        ),
    })
    .strict(),
]);
export type GenerationModelPolicy = z.infer<typeof generationModelPolicySchema>;

/** 图像编辑使用 image 策略，执行前再按任务能力过滤。 */
export const modelDefaultsSchema = z
  .object({
    chat: modelReferenceSchema.nullable(),
    image: generationModelPolicySchema,
    video: generationModelPolicySchema,
  })
  .strict();
export type ModelDefaults = z.infer<typeof modelDefaultsSchema>;
