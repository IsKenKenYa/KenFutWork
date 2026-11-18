import { z } from "zod";

/** 本机实例元数据；不包含账户、凭据、角色或商业权益。 */
export const instanceResponseSchema = z.object({
  instanceId: z.uuid(),
  dataDir: z.string().min(1),
});

export type InstanceContext = z.infer<typeof instanceResponseSchema>;

export const instanceDataLocationResponseSchema = z.object({
  dataDir: z.string().min(1),
  canMove: z.boolean(),
});

export const instanceDataLocationPrepareRequestSchema = z
  .object({
    dataDir: z.string().min(1),
  })
  .strict();
export const instanceDataLocationPrepareResponseSchema = z.object({
  ready: z.literal(true),
});
export const instanceDataLocationShutdownResponseSchema = z.object({
  accepted: z.literal(true),
});
