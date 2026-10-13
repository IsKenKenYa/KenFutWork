import { z } from "zod";

export const designTaskPolicyUpdateRequestSchema = z
  .object({
    expectedScopeGeneration: z.number().int().nonnegative(),
    expectedBranchGeneration: z.number().int().positive(),
    mode: z.enum(["build", "edit", "yolo"]).optional(),
    planEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (input) => input.mode !== undefined || input.planEnabled !== undefined,
    { message: "请选择权限或规划设置。" },
  );

export type DesignTaskPolicyUpdateRequest = z.infer<
  typeof designTaskPolicyUpdateRequestSchema
>;
