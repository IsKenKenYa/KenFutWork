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

export type CodeTaskOrganizationTarget = z.infer<
  typeof codeTaskOrganizationTargetSchema
>;
