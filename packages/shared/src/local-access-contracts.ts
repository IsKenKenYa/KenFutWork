import { z } from "zod";

export const localAccessClientKindSchema = z.enum([
  "desktop",
  "browser",
  "api",
]);

/** 本机接入记录不含令牌或令牌哈希。 */
export const localAccessClientSchema = z.object({
  id: z.uuid(),
  kind: localAccessClientKindSchema,
  label: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
});

const clientLabelSchema = z.string().trim().min(1).max(120);

export const localAccessTicketRequestSchema = z.object({}).strict();
export const localAccessTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
});
export const localAccessConnectRequestSchema = z
  .object({ ticket: z.string().min(1), label: clientLabelSchema.optional() })
  .strict();
export const localAccessConnectResponseSchema = z.object({
  instanceId: z.uuid(),
  client: localAccessClientSchema,
});
export const localAccessClientCreateRequestSchema = z
  .object({ label: clientLabelSchema })
  .strict();
/** 脚本令牌仅在签发响应中出现一次。 */
export const localAccessClientCreateResponseSchema = z.object({
  client: localAccessClientSchema,
  token: z.string().min(1),
});
export const localAccessClientListResponseSchema = z.object({
  clients: z.array(localAccessClientSchema),
});
export const localAccessClientParamsSchema = z.object({ id: z.uuid() });
export const localAccessErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "invalid_input",
  "local_access_invalid_ticket",
  "local_access_unavailable",
]);
export const localAccessErrorResponseSchema = z.object({
  error: z.object({
    code: localAccessErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export type LocalAccessClient = z.infer<typeof localAccessClientSchema>;
export type LocalAccessClientKind = z.infer<typeof localAccessClientKindSchema>;
export type LocalAccessTicketResponse = z.infer<
  typeof localAccessTicketResponseSchema
>;
export type LocalAccessConnectRequest = z.infer<
  typeof localAccessConnectRequestSchema
>;
export type LocalAccessErrorCode = z.infer<typeof localAccessErrorCodeSchema>;
