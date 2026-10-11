import { z } from "zod";
import { runIdSchema } from "./contracts.js";
import { designTaskPolicyResponseSchema } from "./http.js";

const identity = {
  goalId: z.uuid(),
  revision: z.number().int().positive().safe(),
};
export const designGoalFenceSchema = z
  .object({ ...identity, branchGeneration: z.number().int().positive().safe() })
  .strict();
export const designGoalCreateRequestSchema = z
  .object({
    objective: z.string().trim().min(1),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("所选模型引用；省略时冻结创建时的实际默认选择"),
    tokenBudget: z.number().int().positive().safe().nullable().optional(),
    expectedBranchGeneration: z.number().int().positive().safe(),
    expectedGoal: z.object(identity).strict().nullable(),
  })
  .strict();
export const designGoalPauseRequestSchema = designGoalFenceSchema;
export const designGoalResumeRequestSchema = designGoalFenceSchema.extend({
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("显式选择重新捕获模型；省略时核验已有调用快照"),
});
export const designGoalBudgetRequestSchema = designGoalFenceSchema.extend({
  tokenBudget: z.number().int().positive().safe().nullable(),
});
export const designGoalSchema = z
  .object({
    ...identity,
    objective: z.string().min(1),
    status: z.enum([
      "active",
      "paused",
      "verifying",
      "complete",
      "notSatisfied",
      "failed",
    ]),
    branchGeneration: z.number().int().positive().safe(),
    tokenBudget: z.number().int().positive().safe().nullable(),
    tokensUsed: z.number().nonnegative(),
    timeUsedSeconds: z.number().nonnegative(),
    iteration: z.number().int().nonnegative(),
    claimedRunId: runIdSchema.nullable(),
    lastSettledRunId: runIdSchema.nullable(),
    runTokensUsed: z.number().nonnegative(),
    runUsageObserved: z.boolean(),
    runStartedAt: z.number().nullable(),
    verification: z
      .object({
        runId: runIdSchema,
        evidence: z.array(
          z
            .object({
              sourceId: z.string().min(1),
              passed: z.boolean(),
              detail: z.string().optional(),
            })
            .strict(),
        ),
        passed: z.boolean(),
        reason: z.string(),
        at: z.number(),
      })
      .strict()
      .nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export const designGoalResponseSchema = z
  .object({
    goal: designGoalSchema.nullable(),
    task: designTaskPolicyResponseSchema.shape.task,
    acceptedRunId: runIdSchema.nullable(),
  })
  .strict();
export type DesignGoalCreateRequest = z.infer<
  typeof designGoalCreateRequestSchema
>;
export type DesignGoalFence = z.infer<typeof designGoalFenceSchema>;
export type DesignGoalResumeRequest = z.infer<
  typeof designGoalResumeRequestSchema
>;
export type DesignGoalBudgetRequest = z.infer<
  typeof designGoalBudgetRequestSchema
>;
export type DesignGoalResponse = z.infer<typeof designGoalResponseSchema>;
