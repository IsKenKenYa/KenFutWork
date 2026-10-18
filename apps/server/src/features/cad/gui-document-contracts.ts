import { posix } from "node:path";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(posix.isAbsolute);
const observationRevision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const cadGuiProcessBirthSchema = z
  .object({
    startSeconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startMicroseconds: z.number().int().min(0).max(999_999),
  })
  .strict();
export const cadGuiApplicationSchema = z.object({
  pid: z.number().int().positive(),
  bundleId: z.literal("org.freecad.FreeCAD"),
  name: z.string(),
  executablePath: absolutePath,
  bundlePath: absolutePath,
  launchedAt: z.number().finite().positive(),
  birth: cadGuiProcessBirthSchema,
});
export type CadGuiApplication = z.infer<typeof cadGuiApplicationSchema>;

export const cadGuiDocumentsInputSchema = z
  .object({
    application: cadGuiApplicationSchema
      .strict()
      .describe(
        "使用 cad_gui_status 返回的完整应用身份，不按名称或默认安装位置猜选。",
      ),
  })
  .strict();

export const cadGuiDocumentMetadataSchema = z
  .object({
    name: z.string().min(1),
    label: z.string(),
    fileName: z.string(),
    uid: z.string(),
    modified: z.boolean(),
    touched: z.boolean(),
    pendingTransaction: z.boolean(),
    active: z.boolean(),
    documentHandle: z.string().uuid(),
    revision: observationRevision,
  })
  .strict();
export type CadGuiDocumentMetadata = z.infer<
  typeof cadGuiDocumentMetadataSchema
>;

const replyFields = {
  protocol: z.literal("kfw-cad-gui-query/2"),
  requestId: z.string().uuid(),
  pid: z.number().int().positive(),
  completed: z.literal(true),
  guiThread: z.literal(true),
  version: z.array(z.string()),
  error: z.string().optional(),
};
export const cadGuiDocumentsReplySchema = z.discriminatedUnion("success", [
  z
    .object({
      ...replyFields,
      success: z.literal(true),
      bridgeEpoch: z.string().uuid(),
      applicationRevision: observationRevision,
      documents: z.array(cadGuiDocumentMetadataSchema),
    })
    .strict(),
  z
    .object({
      ...replyFields,
      success: z.literal(false),
      bridgeEpoch: z.null(),
      applicationRevision: z.null(),
      documents: z.tuple([]),
    })
    .strict(),
]);
export type CadGuiDocumentsSnapshot = {
  application: CadGuiApplication;
  observationId: string;
  bridgeEpoch: string;
  applicationRevision: number;
  version: string[];
  documents: CadGuiDocumentMetadata[];
};
