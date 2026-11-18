import { modelSelectionSchema } from "@zcode/shared";
import { z } from "zod";

/** First-party host metadata; the original ZCode command and snapshot stay unchanged. */
export const codeGoalFenceSchema = z
  .object({
    goalId: z.string().min(1),
    revision: z.number().int().positive().safe(),
  })
  .strict();
export const codeGoalControlSchema = z
  .object({
    expectedGoal: codeGoalFenceSchema.nullable(),
    resumeModelSelection: modelSelectionSchema.optional(),
  })
  .strict();
export const codeGoalControlStateSchema = z
  .object({
    taskId: z.string().min(1),
    goal: codeGoalFenceSchema.nullable(),
  })
  .strict();
export type CodeGoalControl = z.infer<typeof codeGoalControlSchema>;
export type CodeGoalControlState = z.infer<typeof codeGoalControlStateSchema>;
