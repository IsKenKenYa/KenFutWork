import { z } from "zod";
import {
  cadGuiDocumentMetadataSchema,
  cadGuiInspectDocumentInputSchema,
} from "./gui-document-contracts.js";

const operationId = z.string().uuid().toLowerCase();
export const cadGuiCopyDocumentInputSchema = cadGuiInspectDocumentInputSchema
  .omit({ objectNames: true })
  .extend({
    operationId,
    outputPath: z
      .string()
      .min(1)
      .regex(/\.FCStd$/iu, "副本文件必须使用 .FCStd 扩展名。")
      .optional(),
  })
  .strict();
export type CadGuiCopyDocumentInput = z.infer<
  typeof cadGuiCopyDocumentInputSchema
>;

export const cadGuiCopyDocumentReceiptSchema = z
  .object({
    protocol: z.literal("kfw-cad-gui-copy/1"),
    operationId,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    pid: z.number().int().positive(),
    guiThread: z.literal(true),
    completed: z.literal(true),
    outcome: z.enum(["copied", "rejected", "partial"]),
    copyStarted: z.boolean(),
    statePreserved: z.boolean(),
    reason: z.string().min(1).optional(),
    artifact: z
      .object({
        name: z.literal("document.FCStd"),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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
      (receipt.outcome !== "copied" ||
        (receipt.copyStarted && receipt.statePreserved && receipt.artifact)) &&
      (receipt.outcome !== "rejected" ||
        (!receipt.copyStarted && receipt.artifact === undefined)) &&
      (receipt.outcome !== "partial" || receipt.copyStarted),
    "复制回执的执行与文件状态不一致。",
  );
export type CadGuiCopyDocumentReceipt = z.infer<
  typeof cadGuiCopyDocumentReceiptSchema
>;
