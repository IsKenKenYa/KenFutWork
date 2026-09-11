import { z } from "zod";

/**
 * BYOK 供应商缝契约（《改造计划》§4.8 / §5）。
 * 红线：apiKey 只写不读——所有响应 schema 一律不含 apiKey 字段（由本文件测试锁死）。
 */

/** 线协议封闭集合：聊天 3 种 + 图视频 4 种；新增协议先扩这里再写适配器。 */
export const providerProtocolSchema = z.enum([
  "openai-compatible",
  "anthropic",
  "gemini",
  "google-image",
  "replicate",
  "volces",
  "metaso",
]);
export type ProviderProtocol = z.infer<typeof providerProtocolSchema>;

export const modelCapabilitySchema = z.enum(["chat", "image", "video"]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

/** OpenAI 兼容网关的兼容性开关（按实例覆盖默认行为）。 */
export const providerCompatSchema = z.object({
  supportsToolCalling: z.boolean().optional(),
  supportsJsonResponseFormat: z.boolean().optional(),
  supportsJsonSchemaResponseFormat: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
});
export type ProviderCompat = z.infer<typeof providerCompatSchema>;

export const providerInstanceModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capability: modelCapabilitySchema,
});
export type ProviderInstanceModel = z.infer<typeof providerInstanceModelSchema>;

const identifier = z.string().min(1);

/** 用户供应商实例（BYOK 核心）：Key 以 apiKeyRef 间接引用，永不回传前端。 */
export const providerInstanceConfigSchema = z.object({
  id: identifier,
  workspaceId: identifier,
  name: z.string().min(1),
  protocol: providerProtocolSchema,
  baseUrl: z.string().optional(),
  apiKeyRef: identifier,
  models: z.array(providerInstanceModelSchema).min(1),
  compat: providerCompatSchema.optional(),
  enabled: z.boolean(),
});
export type ProviderInstanceConfig = z.infer<
  typeof providerInstanceConfigSchema
>;

// --- HTTP 请求/响应（服务端 provider 设置 CRUD） ---

export const providerInstanceCreateRequestSchema = z.object({
  name: z.string().min(1),
  protocol: providerProtocolSchema,
  baseUrl: z.string().optional(),
  /** 只写不读：创建时提交明文 Key，服务端加密落库后仅存 ref。 */
  apiKey: z.string().min(1),
  models: z.array(providerInstanceModelSchema).min(1),
  compat: providerCompatSchema.optional(),
  enabled: z.boolean().optional(),
});
export type ProviderInstanceCreateRequest = z.infer<
  typeof providerInstanceCreateRequestSchema
>;

export const providerInstanceUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  baseUrl: z.string().optional(),
  /** 只写不读：更新即覆盖，永不回显旧值。 */
  apiKey: z.string().min(1).optional(),
  models: z.array(providerInstanceModelSchema).min(1).optional(),
  compat: providerCompatSchema.optional(),
  enabled: z.boolean().optional(),
});
export type ProviderInstanceUpdateRequest = z.infer<
  typeof providerInstanceUpdateRequestSchema
>;

/** 实例响应：只有 apiKeyRef 语义的 hasCredential 标记，绝无 key 本体。 */
export const providerInstanceResponseSchema = z.object({
  id: identifier,
  name: z.string().min(1),
  protocol: providerProtocolSchema,
  baseUrl: z.string().optional(),
  hasCredential: z.boolean(),
  models: z.array(providerInstanceModelSchema),
  compat: providerCompatSchema.optional(),
  enabled: z.boolean(),
});
export type ProviderInstanceResponse = z.infer<
  typeof providerInstanceResponseSchema
>;

export const providerInstanceListResponseSchema = z.object({
  instances: z.array(providerInstanceResponseSchema),
});
export type ProviderInstanceListResponse = z.infer<
  typeof providerInstanceListResponseSchema
>;

// --- 模型目录（modelCatalog 从用户实例推导） ---

export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capability: modelCapabilitySchema,
  provider: z.object({
    instanceId: identifier,
    name: z.string().min(1),
    protocol: providerProtocolSchema,
  }),
});
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;

export const modelCatalogResponseSchema = z.object({
  models: z.array(modelCatalogEntrySchema),
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
