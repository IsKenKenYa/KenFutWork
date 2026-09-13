// @admin — 平台管理后台契约（FORM-10：系统供应商分发 + 计费/额度统一管理）
import { z } from "zod";

import { subscriptionPlanSchema } from "./credits.js";
import {
  providerCompatSchema,
  providerInstanceModelSchema,
  providerInstanceResponseSchema,
  providerProtocolSchema,
} from "./provider-contracts.js";

/** 平台角色（与 workspace_members.role 不同层：这是「谁是平台管理员」）。 */
export const platformRoleSchema = z.enum(["user", "admin"]);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const adminMeResponseSchema = z.object({
  isAdmin: z.boolean(),
});
export type AdminMeResponse = z.infer<typeof adminMeResponseSchema>;

/** 后台用户行：账号 + 归属工作区 + 套餐/额度 + 用量汇总。 */
export const adminUserSummarySchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: platformRoleSchema,
  workspaceId: z.string().nullable(),
  plan: subscriptionPlanSchema,
  balance: z.number().int(),
  totalTokens: z.number().int(),
  costUsd: z.number(),
});
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;

export const adminUserListResponseSchema = z.object({
  users: z.array(adminUserSummarySchema),
});
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>;

/** 手动调节额度：正数发放、负数扣减（账户级 admin_adjustment 台账）。 */
export const adminGrantCreditsRequestSchema = z.object({
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: "amount must be non-zero" }),
  description: z.string().max(200).optional(),
});
export type AdminGrantCreditsRequest = z.infer<
  typeof adminGrantCreditsRequestSchema
>;

export const adminSetRoleRequestSchema = z.object({
  role: platformRoleSchema,
});
export type AdminSetRoleRequest = z.infer<typeof adminSetRoleRequestSchema>;

/** 系统供应商（平台池）：管理员配置 Key，分发给全体用户使用。 */
export const adminSystemInstanceCreateRequestSchema = z.object({
  name: z.string().min(1),
  protocol: providerProtocolSchema,
  baseUrl: z.string().optional(),
  /** 只写不读：服务端加密落库，永不回显。 */
  apiKey: z.string().min(1),
  models: z.array(providerInstanceModelSchema).min(1),
  compat: providerCompatSchema.optional(),
  enabled: z.boolean().optional(),
});
export type AdminSystemInstanceCreateRequest = z.infer<
  typeof adminSystemInstanceCreateRequestSchema
>;

export const adminSystemInstanceUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().min(1).optional(),
  models: z.array(providerInstanceModelSchema).min(1).optional(),
  compat: providerCompatSchema.optional(),
  enabled: z.boolean().optional(),
});
export type AdminSystemInstanceUpdateRequest = z.infer<
  typeof adminSystemInstanceUpdateRequestSchema
>;

export const adminSystemInstanceListResponseSchema = z.object({
  instances: z.array(providerInstanceResponseSchema),
});
export type AdminSystemInstanceListResponse = z.infer<
  typeof adminSystemInstanceListResponseSchema
>;

/** 平台用量总览（跨用户聚合，供后台展示）。 */
export const adminPlatformUsageResponseSchema = z.object({
  totals: z.object({
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    totalTokens: z.number().int(),
    costUsd: z.number(),
  }),
  byUser: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      totalTokens: z.number().int(),
      costUsd: z.number(),
    }),
  ),
});
export type AdminPlatformUsageResponse = z.infer<
  typeof adminPlatformUsageResponseSchema
>;
