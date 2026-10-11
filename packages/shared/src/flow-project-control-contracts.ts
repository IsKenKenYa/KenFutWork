import { z } from "zod";

export const flowProjectControlActionSchema = z.enum([
  "snapshot",
  "quiesce",
  "complete-relink",
]);
export const flowProjectControlProjectIdSchema = z.string().uuid();

export const flowProjectControlRequestSchema = z
  .object({
    action: flowProjectControlActionSchema,
    hostSubject: z.string().min(1).max(256),
    operationId: z.string().uuid(),
    expectedGeneration: z.number().int().nonnegative().safe(),
  })
  .strict();

export const flowProjectControlReceiptSchema = z
  .object({
    projectId: z.string().uuid(),
    generation: z.number().int().positive().safe(),
    draining: z.boolean(),
    localSettled: z.boolean(),
    activeRunIds: z.array(z.string()),
    remoteStopped: z.number().int().nonnegative(),
    remoteOutstanding: z.number().int().nonnegative(),
    operationId: z.string().uuid().nullable(),
    quiesceSettled: z.boolean(),
  })
  .strict();

export const flowProjectControlMutationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("confirmed"),
      receipt: flowProjectControlReceiptSchema,
    }),
    z.object({
      status: z.literal("unknown"),
      observation: flowProjectControlReceiptSchema.nullable(),
    }),
  ],
);

export type FlowProjectControlAction = z.infer<
  typeof flowProjectControlActionSchema
>;
export type FlowProjectControlRequest = z.infer<
  typeof flowProjectControlRequestSchema
>;
export type FlowProjectControlReceipt = z.infer<
  typeof flowProjectControlReceiptSchema
>;
export type FlowProjectControlMutationResult = z.infer<
  typeof flowProjectControlMutationResultSchema
>;
