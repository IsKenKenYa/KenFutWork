import { conversationTaskControlSchema } from "@zcode/shared/zcode-protocol-v4";
import { z } from "zod";

const localHost = z.literal("local").optional();
const directoryAccess = z.enum(["read-only", "read-write"]);
const projectRevision = z.int32().nonnegative();

export const codeProjectEditorRootSchema = z
  .object({
    rootPath: z.string().min(1),
    position: z.number().int().nonnegative().safe(),
    isPrimary: z.boolean(),
    access: directoryAccess.optional(),
  })
  .strict();

export const codeProjectEditorProjectSchema = z
  .object({
    id: z.uuid(),
    hostId: z.literal("local"),
    name: z.string().min(1),
    roots: z.array(codeProjectEditorRootSchema),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    revision: projectRevision,
    pinned: z.boolean().default(false),
    deleted: z.boolean().optional(),
  })
  .strict();

export const codeProjectEditorReadProjectsSchema = z
  .object({
    hostId: localHost,
    includeDeleted: z.literal(false).optional(),
  })
  .strict();

export const codeProjectPrepareSessionSchema = z
  .object({
    projectId: z.uuid(),
    hostId: localHost,
    preset: z.enum(["code", "design"]).default("code"),
  })
  .strict();

export const codeProjectPrepareSessionArgsSchema = z.tuple([
  codeProjectPrepareSessionSchema,
]);

export const codeProjectPreparedSessionSchema = z
  .object({
    projectId: z.uuid(),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1),
  })
  .strict();

export const codeProjectPreparedSessionResponseSchema = z
  .object({ result: codeProjectPreparedSessionSchema })
  .strict();

export const codeProjectEditorReadTreeSchema = z
  .object({
    hostId: localHost,
    includeDeleted: z.boolean().optional(),
    includeDeletedTasks: z.boolean().optional(),
  })
  .strict();

export const codeProjectEditorReadTreeArgsSchema = z.tuple([
  codeProjectEditorReadTreeSchema.nullish().optional(),
]);

export const codeProjectTreeTaskSchema = z
  .object({
    taskId: z.uuid(),
    traceId: z.string(),
    projectId: z.uuid(),
    hostId: z.literal("local"),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1),
    workModes: z.array(z.enum(["code", "design"])).optional(),
    title: z.string(),
    titleOverridden: z.boolean().optional(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    mode: z.enum(["plan", "build", "yolo"]),
    model: z.string().optional(),
    thoughtLevel: z.string().optional(),
    status: z.enum(["error", "running", "completed"]).optional(),
    pinned: z.boolean(),
    archived: z.boolean(),
    taskControl: conversationTaskControlSchema.optional(),
  })
  .strict();

/** 删除已清除目录；只传递仍持久保存的稳定身份。 */
export const codeProjectTreeDeletedTaskSchema = z
  .object({
    taskId: z.uuid(),
    projectId: z.uuid(),
    hostId: z.literal("local"),
  })
  .strict();

export const codeProjectTreeSchema = z
  .object({
    projects: z.array(codeProjectEditorProjectSchema),
    tasks: z.array(codeProjectTreeTaskSchema),
    deletedTasks: z.array(codeProjectTreeDeletedTaskSchema).optional(),
  })
  .strict();

export const codeProjectTreeRpcResponseSchema = z.object({
  result: codeProjectTreeSchema,
});

export const codeProjectEditorReadDirectorySchema = z
  .object({
    hostId: localHost,
    path: z.string().optional(),
    includeHidden: z.boolean().optional(),
  })
  .strict();

export const codeProjectEditorDirectorySchema = z
  .object({
    path: z.string().min(1),
    entries: z.array(
      z
        .object({
          name: z.string(),
          path: z.string().min(1),
          type: z.literal("directory"),
          isSymbolicLink: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const projectSaveFields = {
  hostId: localHost,
  name: z.string().trim().min(1).optional(),
  roots: z.array(z.string().min(1)).min(1),
  primaryRoot: z.string().min(1).optional(),
  rootPermissions: z.record(z.string().min(1), directoryAccess),
};

export const codeProjectEditorEditSchema = z
  .object({
    ...projectSaveFields,
    id: z.uuid(),
    expectedRevision: projectRevision,
  })
  .strict();

export const codeProjectEditorCreateSchema = z
  .object({
    ...projectSaveFields,
    creationId: z.uuid(),
    kind: z.enum(["code", "design"]),
    directoryChoice: z.literal("independent").optional(),
  })
  .strict();

export const codeProjectEditorPinSchema = z
  .object({
    id: z.uuid(),
    hostId: localHost,
    expectedRevision: projectRevision,
    pinned: z.boolean(),
  })
  .strict();

export const codeProjectEditorSaveSchema = z.union([
  codeProjectEditorEditSchema,
  codeProjectEditorCreateSchema,
  codeProjectEditorPinSchema,
]);

export const codeProjectEditorSaveArgsSchema = z.tuple([
  codeProjectEditorSaveSchema,
]);

export const codeProjectEditorDeleteArgsSchema = z.tuple([z.uuid(), localHost]);

export type CodeProjectEditorProject = z.infer<
  typeof codeProjectEditorProjectSchema
>;
export type CodeProjectEditorSave = z.infer<typeof codeProjectEditorSaveSchema>;
export type CodeProjectEditorCreate = z.infer<
  typeof codeProjectEditorCreateSchema
>;
export type CodeProjectEditorEdit = z.infer<typeof codeProjectEditorEditSchema>;
export type CodeProjectEditorPin = z.infer<typeof codeProjectEditorPinSchema>;
export type CodeProjectEditorReadProjects = z.infer<
  typeof codeProjectEditorReadProjectsSchema
>;
export type CodeProjectPrepareSession = z.infer<
  typeof codeProjectPrepareSessionSchema
>;
export type CodeProjectPreparedSession = z.infer<
  typeof codeProjectPreparedSessionSchema
>;
export type CodeProjectEditorReadTree = z.infer<
  typeof codeProjectEditorReadTreeSchema
>;
export type CodeProjectTree = z.infer<typeof codeProjectTreeSchema>;
export type CodeProjectEditorReadDirectory = z.infer<
  typeof codeProjectEditorReadDirectorySchema
>;
export type CodeProjectEditorDirectory = z.infer<
  typeof codeProjectEditorDirectorySchema
>;
