import {
  commandPayloadSchemas,
  pendingInteractionSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";

export const designApprovalParamsSchema = z
  .object({ taskId: z.uuid(), interactionId: z.uuid() })
  .strict();
export const designApprovalListResponseSchema = z.object({
  approvals: z.array(pendingInteractionSchema),
});
/** Original canonical permission/plan-approval answer; no client-owned binding facts. */
export const designApprovalResolveRequestSchema = z
  .object({
    answer: commandPayloadSchemas.resolveInteraction.shape.answer
      .omit({ freeText: true })
      .strict(),
  })
  .strict();
export const designApprovalResolveResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      status: z.literal("resolved"),
      decision: z.enum(["allow", "deny"]),
    }),
    z.object({
      status: z.literal("alreadyResolved"),
      reasonCode: z.literal("proto.alreadyResolved"),
    }),
  ],
);

export type DesignApprovalListResponse = z.infer<
  typeof designApprovalListResponseSchema
>;
export type DesignApprovalResolveRequest = z.infer<
  typeof designApprovalResolveRequestSchema
>;
export type DesignApprovalResolveResponse = z.infer<
  typeof designApprovalResolveResponseSchema
>;
