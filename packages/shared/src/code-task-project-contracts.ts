import { z } from "zod";

/** 原项目拖动输入附带真人观察到的来源项目与 Task 修订。 */
export const codeTaskProjectMoveInputSchema = z
  .object({
    task: z
      .object({
        taskId: z.uuid(),
        workspacePath: z.string().min(1),
        workspaceIdentity: z.string().min(1).optional(),
      })
      .strict(),
    projectId: z.uuid(),
    sourceProjectId: z.uuid(),
    observedRevision: z.number().int().nonnegative().safe(),
    hostId: z.string().min(1).optional(),
    addMissingRoot: z.boolean().optional(),
  })
  .strict();

export const codeTaskProjectMoveArgsSchema = z.tuple([
  codeTaskProjectMoveInputSchema,
]);

export type CodeTaskProjectMoveInput = z.infer<
  typeof codeTaskProjectMoveInputSchema
>;
