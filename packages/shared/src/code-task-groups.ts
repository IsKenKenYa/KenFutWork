import { z } from "zod";

export const codeTaskGroupColorSchema = z.enum([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
]);

export const codeTaskGroupSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(200),
    color: codeTaskGroupColorSchema,
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
  })
  .strict();

/** 组织修订独立于 Task 的执行分支和授权代际。 */
export const codeTaskGroupStructureSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    groups: z.array(codeTaskGroupSchema),
    members: z.array(
      z
        .object({
          groupId: z.uuid(),
          workspaceKey: z.string().min(1),
          taskId: z.uuid(),
          sortOrder: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    order: z.array(
      z
        .object({
          type: z.enum(["group", "task"]),
          key: z.string().min(1),
          sortOrder: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const codeTaskGroupReadArgsSchema = z.tuple([]);
const groupRevisionSchema = z.number().int().nonnegative().safe();
const groupSaveFields = {
  expectedRevision: groupRevisionSchema,
  title: z.string().trim().min(1).max(200).optional(),
  color: codeTaskGroupColorSchema.optional(),
};
export const codeTaskGroupSaveSchema = z.union([
  z.object({ creationId: z.uuid(), ...groupSaveFields }).strict(),
  z.object({ id: z.uuid(), ...groupSaveFields }).strict(),
]);
export const codeTaskGroupSaveArgsSchema = z.tuple([codeTaskGroupSaveSchema]);
export const codeTaskGroupSaveResponseSchema = z
  .object({ result: codeTaskGroupSchema })
  .strict();
export const codeTaskGroupReadResponseSchema = z
  .object({
    result: codeTaskGroupStructureSchema,
  })
  .strict();
export type CodeTaskGroupStructure = z.infer<
  typeof codeTaskGroupStructureSchema
>;
export type CodeTaskGroup = z.infer<typeof codeTaskGroupSchema>;
export type CodeTaskGroupSave = z.infer<typeof codeTaskGroupSaveSchema>;
