import { z } from "zod";
import {
  cadGuiDocumentMetadataSchema,
  cadGuiInspectDocumentInputSchema,
  cadGuiPropertyValueSchema,
} from "./gui-document-contracts.js";

const operationId = z.string().uuid().toLowerCase();
const propertyChangeSchema = z
  .object({
    objectName: z.string().min(1),
    propertyName: z.string().min(1),
    expectedValue: cadGuiPropertyValueSchema,
    value: cadGuiPropertyValueSchema,
  })
  .strict();

export const cadGuiSetPropertiesInputSchema = cadGuiInspectDocumentInputSchema
  .omit({ objectNames: true })
  .extend({
    operationId,
    changes: z
      .array(propertyChangeSchema)
      .min(1)
      .refine(
        (changes) =>
          new Set(
            changes.map((change) =>
              JSON.stringify([change.objectName, change.propertyName]),
            ),
          ).size === changes.length,
        "同一次操作不能重复修改相同属性。",
      ),
    recompute: z.boolean().default(true),
  })
  .strict();
export type CadGuiSetPropertiesInput = z.infer<
  typeof cadGuiSetPropertiesInputSchema
>;

export const cadGuiOperationStatusInputSchema = z
  .object({ operationId })
  .strict();

export const cadGuiOperationReceiptSchema = z
  .object({
    protocol: z.literal("kfw-cad-gui-operation/1"),
    operationId,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    pid: z.number().int().positive(),
    guiThread: z.literal(true),
    completed: z.literal(true),
    outcome: z.enum(["no_op", "committed", "rejected", "partial"]),
    mutationStarted: z.boolean(),
    commitAttempted: z.boolean(),
    commitObserved: z.boolean(),
    reason: z.string().min(1).optional(),
    changes: z.array(
      z
        .object({
          objectName: z.string().min(1),
          propertyName: z.string().min(1),
          before: cadGuiPropertyValueSchema,
          requested: cadGuiPropertyValueSchema,
          observed: cadGuiPropertyValueSchema.optional(),
          changed: z.boolean(),
        })
        .strict(),
    ),
    transactionState: z.enum(["none", "own_pending", "changed", "unknown"]),
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
      (!receipt.commitObserved || receipt.commitAttempted) &&
      (!receipt.commitAttempted || receipt.mutationStarted) &&
      (receipt.outcome !== "committed" ||
        (receipt.commitObserved && receipt.transactionState === "none")) &&
      (!["no_op", "rejected"].includes(receipt.outcome) ||
        (!receipt.mutationStarted &&
          !receipt.commitAttempted &&
          !receipt.commitObserved &&
          receipt.transactionState === "none")),
    "操作回执的修改与提交状态不一致。",
  );
export type CadGuiOperationReceipt = z.infer<
  typeof cadGuiOperationReceiptSchema
>;
