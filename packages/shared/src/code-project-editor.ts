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
  })
  .strict();

export const codeProjectEditorReadProjectsSchema = z
  .object({
    hostId: localHost,
    includeDeleted: z.literal(false).optional(),
  })
  .strict();

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

export const codeProjectEditorSaveSchema = z
  .object({
    id: z.uuid(),
    hostId: localHost,
    name: z.string().trim().min(1).optional(),
    roots: z.array(z.string().min(1)).min(1),
    primaryRoot: z.string().min(1).optional(),
    rootPermissions: z.record(z.string().min(1), directoryAccess),
    expectedRevision: projectRevision,
  })
  .strict();

export const codeProjectEditorDeleteArgsSchema = z.tuple([z.uuid(), localHost]);

export type CodeProjectEditorProject = z.infer<
  typeof codeProjectEditorProjectSchema
>;
export type CodeProjectEditorSave = z.infer<typeof codeProjectEditorSaveSchema>;
export type CodeProjectEditorReadProjects = z.infer<
  typeof codeProjectEditorReadProjectsSchema
>;
export type CodeProjectEditorReadDirectory = z.infer<
  typeof codeProjectEditorReadDirectorySchema
>;
export type CodeProjectEditorDirectory = z.infer<
  typeof codeProjectEditorDirectorySchema
>;
