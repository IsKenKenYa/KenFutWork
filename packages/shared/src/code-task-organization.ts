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
