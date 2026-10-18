import { posix } from "node:path";
import { z } from "zod";
import {
  cadGuiDocumentMetadataSchema,
  cadGuiInspectDocumentInputSchema,
} from "./gui-document-contracts.js";

const operationId = z.string().uuid().toLowerCase();
const savedFileName = z
  .string()
  .min(1)
  .refine(
    (value) =>
      posix.isAbsolute(value) &&
      !value.includes("\0") &&
      value.toLowerCase().endsWith(".fcstd"),
    "请选择已有的绝对 .FCStd 文件路径。",
  );

export const cadGuiSaveDocumentInputSchema = cadGuiInspectDocumentInputSchema
  .omit({ objectNames: true })
  .extend({
    operationId,
    expectedFileName: savedFileName.describe("最新文档快照中的已有文件路径。"),
  })
  .strict();
export type CadGuiSaveDocumentInput = z.infer<
  typeof cadGuiSaveDocumentInputSchema
>;

export const cadGuiSaveDocumentReceiptSchema = z
  .object({
    protocol: z.literal("kfw-cad-gui-save/1"),
    operationId,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    pid: z.number().int().positive(),
    guiThread: z.literal(true),
    completed: z.literal(true),
    outcome: z.enum(["saved", "rejected", "partial"]),
    saveStarted: z.boolean(),
    writeFinished: z.literal(true),
    reason: z.string().min(1).optional(),
    artifact: z
      .object({
        canonicalPath: savedFileName,
        size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        hasGuiDocument: z.literal(true),
      })
      .strict()
      .optional(),
    snapshot: z
      .object({
        bridgeEpoch: z.string().uuid(),
        applicationRevision: z
          .number()
          .int()
          .min(0)
          .max(Number.MAX_SAFE_INTEGER),
        document: cadGuiDocumentMetadataSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (receipt) =>
      (receipt.outcome !== "saved" ||
        (receipt.saveStarted && receipt.artifact !== undefined)) &&
      (receipt.outcome !== "rejected" ||
        (!receipt.saveStarted && receipt.artifact === undefined)) &&
      (receipt.outcome !== "partial" || receipt.saveStarted),
    "保存回执的执行与文件状态不一致。",
  );
export type CadGuiSaveDocumentReceipt = z.infer<
  typeof cadGuiSaveDocumentReceiptSchema
>;
