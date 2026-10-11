import { z } from "zod";
import { flowProjectControlReceiptSchema } from "./flow-project-control-contracts.js";

export const projectDirectoryFlowPhaseSchema = z.enum([
  "idle",
  "available",
  "staged",
  "quiesce_unknown",
  "quiesced",
  "root_published",
  "complete_unknown",
  "complete",
]);
export const projectDirectoryFlowStateSchema = z
  .object({
    generation: z.number().int().positive().safe(),
    operationId: z.uuid(),
    phase: projectDirectoryFlowPhaseSchema,
    previousWorkDir: z.string().min(1),
    nextWorkDir: z.string().min(1).nullable(),
    receipt: flowProjectControlReceiptSchema.nullable(),
  })
  .strict();

const taskFence = z
  .object({
    taskId: z.uuid(),
    scopeGeneration: z.number().int().positive().safe(),
    branchGeneration: z.number().int().positive().safe(),
  })
  .strict();
export const projectDirectoryRelinkParamsSchema = z
  .object({ projectId: z.uuid() })
  .strict();
export const projectDirectoryRelinkRequestSchema = z
  .object({
    expectedWorkDir: z.string().min(1),
    nextWorkDir: z.string().min(1),
    expectedTasks: z.array(taskFence),
    expectedFlow: z
      .object({
        generation: z.number().int().positive().safe(),
        operationId: z.uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const projectDirectoryRelinkResponseSchema = z
  .object({
    projectId: z.uuid(),
    workDir: z.string().min(1),
    tasks: z.array(taskFence.extend({ status: z.literal("ready") })),
    affectedTaskIds: z.array(z.uuid()),
    flow: projectDirectoryFlowStateSchema.optional(),
  })
  .strict();
export const projectDirectoryRelinkSnapshotSchema = z
  .object({
    projectId: z.uuid(),
    workDir: z.string().min(1),
    tasks: z.array(taskFence),
    flow: projectDirectoryFlowStateSchema.optional(),
  })
  .strict();
export type ProjectDirectoryRelinkSnapshot = z.infer<
  typeof projectDirectoryRelinkSnapshotSchema
>;
export type ProjectDirectoryRelinkRequest = z.infer<
  typeof projectDirectoryRelinkRequestSchema
>;
export type ProjectDirectoryRelinkResponse = z.infer<
  typeof projectDirectoryRelinkResponseSchema
>;
