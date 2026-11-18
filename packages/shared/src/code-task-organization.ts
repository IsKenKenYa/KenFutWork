import { conversationTaskControlSchema } from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";

/** 原任务行的明确组织操作，观察值由宿主项目树或会话快照提供。 */
export const codeTaskOrganizationTargetSchema = z
  .object({
    taskId: z.uuid(),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1),
    taskControl: conversationTaskControlSchema,
  })
  .strict();

export const codeTaskOrganizationArgsSchema = z.tuple([
  codeTaskOrganizationTargetSchema,
]);

const unreadMarker = z.number().int().nonnegative().safe();

export const codeTaskUnreadObservationSchema =
  codeTaskOrganizationTargetSchema.extend({
    observedLastUnreadAt: unreadMarker,
  });

export const codeTaskUnreadInputSchema = codeTaskUnreadObservationSchema.extend(
  {
    unread: z.boolean(),
    expectedUnreadAt: unreadMarker.optional(),
  },
);

export const codeTaskUnreadArgsSchema = z.tuple([codeTaskUnreadInputSchema]);

export const codeTaskUnreadControllerMutationSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("mark-unread") }).strict(),
    z
      .object({
        kind: z.literal("mark-read"),
        expectedUnreadAt: unreadMarker.optional(),
      })
      .strict(),
  ],
);

export const codeTaskUnreadControllerInputSchema = z
  .object({
    address: codeTaskUnreadObservationSchema,
    mutation: codeTaskUnreadControllerMutationSchema,
  })
  .strict();

export const codeTaskUnreadControllerArgsSchema = z.tuple([
  codeTaskUnreadControllerInputSchema,
]);

export const codeTaskPinObservationSchema =
  codeTaskOrganizationTargetSchema.extend({
    observedPinRevision: z.number().int().nonnegative().safe(),
  });

export const codeTaskPinInputSchema = codeTaskPinObservationSchema.extend({
  pinned: z.boolean(),
});

export const codeTaskPinArgsSchema = z.tuple([codeTaskPinInputSchema]);

export const codeTaskPinControllerInputSchema = z
  .object({
    address: codeTaskPinObservationSchema,
    mutation: z
      .object({ kind: z.literal("pin"), pinned: z.boolean() })
      .strict(),
  })
  .strict();

export const codeTaskPinControllerArgsSchema = z.tuple([
  codeTaskPinControllerInputSchema,
]);

export const codeTaskControllerMutationArgsSchema = z.union([
  codeTaskUnreadControllerArgsSchema,
  codeTaskPinControllerArgsSchema,
]);

export type CodeTaskOrganizationTarget = z.infer<
  typeof codeTaskOrganizationTargetSchema
>;
export type CodeTaskUnreadObservation = z.infer<
  typeof codeTaskUnreadObservationSchema
>;
export type CodeTaskUnreadInput = z.infer<typeof codeTaskUnreadInputSchema>;
export type CodeTaskUnreadControllerInput = z.infer<
  typeof codeTaskUnreadControllerInputSchema
>;
export type CodeTaskPinObservation = z.infer<
  typeof codeTaskPinObservationSchema
>;
export type CodeTaskPinInput = z.infer<typeof codeTaskPinInputSchema>;
export type CodeTaskPinControllerInput = z.infer<
  typeof codeTaskPinControllerInputSchema
>;
