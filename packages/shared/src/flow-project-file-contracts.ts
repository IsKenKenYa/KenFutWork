import { z } from "zod";

const version = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z.string().min(1).max(4096);
export const flowProjectFileParamsSchema = z.object({
  assetId: z.string().uuid(),
});
export const flowLayoutParamsSchema = z.object({
  workflowId: z.string().uuid(),
});
export const flowProjectFileVersionSchema = z.object({ version });
export const flowProjectFileUploadSchema = z.object({
  assetId: z.string().uuid(),
  relativePath,
  mimeType: z.string().min(1).max(120),
  writeFingerprint: version,
});
export const flowProjectFileReceiptSchema = z.object({
  assetId: z.string().uuid(),
  relativePath,
  version,
});
export const flowProjectFileMetadataSchema =
  flowProjectFileReceiptSchema.extend({
    mimeType: z.string().min(1).max(120),
    sizeBytes: z.number().int().nonnegative(),
  });
export const flowProjectFileMoveSchema = z.object({
  relativePath,
  expectedRelativePath: relativePath,
  expectedVersion: version,
});
export const flowLayoutWriteSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  expectedVersion: version.nullable(),
});
export const flowLayoutSnapshotSchema = z.object({
  content: z.record(z.string(), z.unknown()),
  version,
});
export const flowProjectFileDeleteReceiptSchema = z.object({
  ok: z.literal(true),
});
