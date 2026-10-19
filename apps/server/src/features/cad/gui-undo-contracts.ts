import { z } from "zod";
import {
  cadGuiDocumentMetadataSchema,
  cadGuiInspectDocumentInputSchema,
  cadGuiPropertyValueSchema,
} from "./gui-document-contracts.js";
import {
  cadGuiHistorySummarySchema,
  cadGuiOperationReceiptSchema,
  cadGuiSetPropertiesInputSchema,
} from "./gui-operation-contracts.js";

const operationId = z.string().uuid().toLowerCase();
const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

export const cadGuiUndoOperationInputSchema = cadGuiInspectDocumentInputSchema
  .omit({ objectNames: true })
  .extend({ operationId, sourceOperationId: operationId })
  .strict()
  .refine(
    (input) => input.operationId !== input.sourceOperationId,
    "撤销操作不能使用原操作编号。",
  );
export type CadGuiUndoOperationInput = z.infer<
  typeof cadGuiUndoOperationInputSchema
>;

/** 仅由宿主从当前 Task 的持久记录读取，不接受模型提供的证明。 */
export const cadGuiUndoSourceSchema = z
  .object({
    input: cadGuiSetPropertiesInputSchema,
    receipt: cadGuiOperationReceiptSchema,
  })
  .strict()
  .refine(({ input, receipt }) => {
    const snapshot = receipt.snapshot;
    if (
      receipt.outcome !== "committed" ||
      !receipt.undoProvenance ||
      !snapshot ||
      receipt.operationId !== input.operationId ||
      receipt.pid !== input.application.pid ||
      snapshot.bridgeEpoch !== input.bridgeEpoch ||
      snapshot.document.documentHandle !== input.documentHandle ||
      snapshot.applicationRevision < input.expectedApplicationRevision ||
      snapshot.document.revision < input.expectedDocumentRevision ||
      receipt.changes.length !== input.changes.length ||
      !receipt.changes.some((change) => change.changed)
    ) {
      return false;
    }
    const rows = new Map(
      receipt.changes.map((change) => [
        JSON.stringify([change.objectName, change.propertyName]),
        change,
      ]),
    );
    return (
      rows.size === input.changes.length &&
      input.changes.every((change) => {
        const row = rows.get(
          JSON.stringify([change.objectName, change.propertyName]),
        );
        return (
          row !== undefined &&
          row.observed !== undefined &&
          sameValue(row.before, change.expectedValue) &&
          sameValue(row.requested, change.value) &&
          sameValue(row.observed, change.value) &&
          row.changed === !sameValue(row.before, row.observed)
        );
      })
    );
  }, "原操作缺少可验证的撤销证明。");
export type CadGuiUndoSource = z.infer<typeof cadGuiUndoSourceSchema>;

export const cadGuiUndoOperationReceiptSchema = z
  .object({
    protocol: z.literal("kfw-cad-gui-undo/1"),
    operationId,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    pid: z.number().int().positive(),
    sourceOperationId: operationId,
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    guiThread: z.literal(true),
    completed: z.literal(true),
    outcome: z.enum(["undone", "rejected", "partial"]),
    undoStarted: z.boolean(),
    undoObserved: z.boolean(),
    historyVerified: z.boolean(),
    transactionName: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    changes: z.array(
      z
        .object({
          objectName: z.string().min(1),
          propertyName: z.string().min(1),
          before: cadGuiPropertyValueSchema,
          observed: cadGuiPropertyValueSchema.optional(),
          changed: z.boolean().optional(),
        })
        .strict(),
    ),
    undoHistory: cadGuiHistorySummarySchema.optional(),
    redoHistory: cadGuiHistorySummarySchema.optional(),
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
      receipt.operationId !== receipt.sourceOperationId &&
      (!receipt.undoObserved || receipt.undoStarted) &&
      (!receipt.historyVerified ||
        (receipt.undoObserved && receipt.undoHistory && receipt.redoHistory)) &&
      (receipt.outcome !== "rejected" ||
        (!receipt.undoStarted &&
          !receipt.undoObserved &&
          !receipt.historyVerified)) &&
      (receipt.outcome !== "partial" || receipt.undoStarted) &&
      (receipt.outcome !== "undone" ||
        (receipt.undoStarted &&
          receipt.undoObserved &&
          receipt.historyVerified &&
          receipt.transactionName !== undefined &&
          receipt.snapshot?.document.active &&
          !receipt.snapshot.document.pendingTransaction &&
          receipt.changes.length > 0 &&
          receipt.changes.some((change) => change.changed) &&
          receipt.changes.every(
            (change) =>
              change.observed !== undefined &&
              change.changed === !sameValue(change.before, change.observed),
          ))),
    "撤销回执的执行、历史与结果状态不一致。",
  );
export type CadGuiUndoOperationReceipt = z.infer<
  typeof cadGuiUndoOperationReceiptSchema
>;
