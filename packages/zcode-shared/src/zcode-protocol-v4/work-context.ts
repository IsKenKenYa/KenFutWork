import { z } from "zod";

const generationPreferenceSchema = z
  .object({
    mode: z.enum(["auto", "manual"]),
    models: z.array(z.string().min(1)),
  })
  .strict();

/** Input-scoped document context. It never grants filesystem access. */
export const conversationWorkContextSchema = z
  .object({
    preset: z.enum(["code", "design"]),
    canvasId: z.string().min(1).optional(),
    selectedCanvasElements: z
      .array(z.record(z.string(), z.unknown()))
      .optional(),
    brandKitId: z.string().min(1).optional(),
    imageGenerationPreference: generationPreferenceSchema.optional(),
    videoGenerationPreference: generationPreferenceSchema.optional(),
  })
  .strict()
  .superRefine((context, issue) => {
    if (context.selectedCanvasElements?.length && !context.canvasId) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canvasId"],
        message: "画布选区必须声明所属画布。",
      });
    }
  });

export type ConversationWorkContext = z.infer<
  typeof conversationWorkContextSchema
>;
