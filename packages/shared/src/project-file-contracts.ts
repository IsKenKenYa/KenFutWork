import { z } from "zod";

const version = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z.string().min(1).max(4096);
export const projectFileParamsSchema = z.object({ assetId: z.string().uuid() });
export const projectFileMoveRequestSchema = z
  .object({
    relativePath,
    expectedRelativePath: relativePath,
    expectedVersion: version,
  })
  .strict();
export const projectFileRelinkRequestSchema = projectFileMoveRequestSchema
  .extend({ fileVersion: version })
  .strict();
export const projectFileLocationSchema = z.object({
  assetId: z.string().uuid(),
  bucket: z.literal("project-assets"),
  objectPath: z.string().min(1),
  relativePath,
  projectId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  version,
});
export const canvasAssetParamsSchema = z.object({
  canvasId: z.string().uuid(),
});
export const canvasAssetRevisionRequestSchema = z
  .object({ expectedRevision: version })
  .strict();
export const canvasAssetMoveRequestSchema = z
  .object({
    relativePath,
    expectedRelativePath: relativePath,
    expectedVersion: version,
    expectedRevision: version,
  })
  .strict();
export const canvasAssetRestoreReceiptSchema = z.object({
  revision: version,
  assetIds: z.array(z.string().uuid()),
});

export type ProjectFileMoveRequest = z.infer<
  typeof projectFileMoveRequestSchema
>;
export type ProjectFileRelinkRequest = z.infer<
  typeof projectFileRelinkRequestSchema
>;
export type ProjectFileLocation = z.infer<typeof projectFileLocationSchema>;
export type CanvasAssetRevisionRequest = z.infer<
  typeof canvasAssetRevisionRequestSchema
>;
export type CanvasAssetMoveRequest = z.infer<
  typeof canvasAssetMoveRequestSchema
>;
export type CanvasAssetRestoreReceipt = z.infer<
  typeof canvasAssetRestoreReceiptSchema
>;
