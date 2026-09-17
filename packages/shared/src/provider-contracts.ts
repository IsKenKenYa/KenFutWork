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

/**
 * 模型级任务能力声明（BYOK 用户/管理员对单个模型的可选细化，docs/future/05 §6）。
 * 语义红线：**字段缺省 = 未知，不是不支持**——目录与 UI 不得把「没声明」当「肯定不行」
 * 处理（kimi-code 的 UNKNOWN 语义）；只有显式声明的取值才可参与运行期裁剪。
 */
export const imageGenerationCapsSchema = z.object({
  /** 支持的生成模式（cherry 词表收窄版；缺省视为仅 generate）。 */
  modes: z
    .array(z.enum(["generate", "edit", "upscale", "remix", "merge"]))
    .min(1)
    .optional(),
  /** false = 该模型不需要提示词（超分/去背景/图像翻译类），管线不得强制非空 prompt。 */
  requirePrompt: z.boolean().optional(),
  /** 单次调用允许的输入参考图上限。 */
  maxInputImages: z.number().int().nonnegative().optional(),
});
export type ImageGenerationCaps = z.infer<typeof imageGenerationCapsSchema>;

/** 视频任务能力（fal per-model input schema 收窄版）。缺省字段同样 = 未知。 */
export const videoGenerationCapsSchema = z.object({
  /** 允许的时长取值（秒）。 */
  durations: z.array(z.number().positive()).min(1).optional(),
  /** 允许的画幅比取值（如 "16:9"）。 */
  aspectRatios: z.array(z.string().min(1)).min(1).optional(),
  /** 允许的分辨率取值（如 "720p"）。 */
  resolutions: z.array(z.string().min(1)).min(1).optional(),
  /** 是否支持首尾帧控制。 */
  firstLastFrame: z.boolean().optional(),
  /** 参考图数量上限。 */
  referenceImages: z.number().int().nonnegative().optional(),
  /** 是否支持负向提示词。 */
  negativePrompt: z.boolean().optional(),
  /** 是否支持生成/保留音频。 */
  audio: z.boolean().optional(),
});
export type VideoGenerationCaps = z.infer<typeof videoGenerationCapsSchema>;

/** OpenAI 兼容网关的兼容性开关（按实例覆盖默认行为）。 */
export const providerCompatSchema = z.object({
  supportsToolCalling: z.boolean().optional(),
  supportsJsonResponseFormat: z.boolean().optional(),
  supportsJsonSchemaResponseFormat: z.boolean().optional(),
  supportsDeveloperRole: z.boolean().optional(),
});
export type ProviderCompat = z.infer<typeof providerCompatSchema>;

/**
 * 自定义请求头（§4.8）：值可写占位符，按**发送时刻**的会话上下文替换。
 * 亲和类头（如 `x-opencode-session`）必须逐会话取值——写死一个固定值会把所有会话
 * 钉到同一上游分片、提示词缓存亲和失效；每次请求现随机生成同样无意义。
 */
export const providerHeaderPlaceholders = ["sessionId", "threadId"] as const;
export type ProviderHeaderPlaceholder =
  (typeof providerHeaderPlaceholders)[number];

/**
 * 保留头（大小写不敏感）：由适配器/运行时按凭证与线协议持有，自定义头**不得覆盖**。
 * 不加这条，就能用自定义头顶掉凭证头，等于绕开「apiKey 只写不读」的整个模型。
 */
export const reservedProviderHeaderNames = [
  // 凭证类：由 apiKey 解析生成，或线协议的 key 头
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  // 寻址与帧界类：由运行时/HTTP 客户端持有
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
  "te",
  "trailer",
  "keep-alive",
  "cookie",
  "set-cookie",
] as const;

export const providerHeadersMaxEntries = 32;
export const providerHeaderValueMaxLength = 1024;

const RESERVED_HEADER_SET = new Set<string>(reservedProviderHeaderNames);

/** RFC 7230 token：头名字符集。 */
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** 可打印 ASCII（含空格），**不含** CR/LF 与控制字符——否则可注入额外头（请求走私）。 */
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]*$/;
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

export function isReservedProviderHeaderName(name: string): boolean {
  return RESERVED_HEADER_SET.has(name.trim().toLowerCase());
}

/** 白名单外的占位符名（空数组 = 全部合法）。写入时即拒，不允许运行时才炸。 */
export function findUnknownProviderHeaderPlaceholders(value: string): string[] {
  const unknown: string[] = [];
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] ?? "";
    if (!(providerHeaderPlaceholders as readonly string[]).includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

export const providerHeaderNameSchema = z
  .string()
  .regex(HTTP_TOKEN_PATTERN, "头名必须是合法 HTTP token（RFC 7230）")
  .refine(
    (name) => !isReservedProviderHeaderName(name),
    "该请求头由适配器持有（凭证/帧界类），不可自定义覆盖",
  );

export const providerHeaderValueSchema = z
  .string()
  .max(providerHeaderValueMaxLength, "头值过长")
  .regex(
    PRINTABLE_ASCII_PATTERN,
    "头值只能含可打印 ASCII 字符，且不得包含换行或控制字符",
  )
  .refine(
    (value) => findUnknownProviderHeaderPlaceholders(value).length === 0,
    "只支持占位符 {{sessionId}} / {{threadId}}（白名单外不做模板求值）",
  );

/** 实例级自定义请求头：头名合法且非保留、头值可打印且只含白名单占位符。 */
export const providerInstanceHeadersSchema = z
  .record(providerHeaderNameSchema, providerHeaderValueSchema)
  .refine(
    (headers) => Object.keys(headers).length <= providerHeadersMaxEntries,
    `自定义请求头最多 ${providerHeadersMaxEntries} 条`,
  )
  .refine(
    (headers) =>
      new Set(Object.keys(headers).map((key) => key.toLowerCase())).size ===
      Object.keys(headers).length,
    "头名不得大小写重复（HTTP 头名不区分大小写）",
  );
export type ProviderInstanceHeaders = z.infer<
  typeof providerInstanceHeadersSchema
>;

export const providerInstanceModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capability: modelCapabilitySchema,
  /** 支持图像输入（前端显示「视觉」徽标）。 */
  vision: z.boolean().optional(),
  /** 上下文窗口 token 数（前端按量级显示徽标，如 1M）。 */
  contextWindow: z.number().int().positive().optional(),
  /**
   * 单次回复的最大输出 token 数（模型声明的上限）。
   *
   * 用途：上下文条里「预留输出」段的**唯一真实来源**——为输出留出的窗口空间。
   * 我们不编这个数（没声明就不画那一段），因为它决定「还剩多少可用」的读数。
   * 此前该字段会被 schema 静默丢弃（用户写了也传不到前端）。
   */
  maxOutputTokens: z.number().int().positive().optional(),
  /** 图像生成任务级能力（可选；缺省 = 未知，见上方语义红线）。 */
  imageGeneration: imageGenerationCapsSchema.optional(),
  /** 视频生成任务级能力（可选；缺省 = 未知）。 */
  videoGeneration: videoGenerationCapsSchema.optional(),
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
  /** 自定义请求头（值含占位符，只写不读）。 */
  headers: providerInstanceHeadersSchema.optional(),
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
  /**
   * 自定义请求头：值只写不读（响应只回 `headerKeys`）。
   * 显式传 `{}` 即清空；缺省表示不设置/不修改。
   */
  headers: providerInstanceHeadersSchema.optional(),
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
  /** 只写不读：更新即整体覆盖（`{}` = 清空）。 */
  headers: providerInstanceHeadersSchema.optional(),
  enabled: z.boolean().optional(),
});
export type ProviderInstanceUpdateRequest = z.infer<
  typeof providerInstanceUpdateRequestSchema
>;

/** 实例作用域：workspace = 用户自带（BYOK）；system = 平台池（管理员配置、分发给用户）。 */
export const providerScopeSchema = z.enum(["workspace", "system"]);
export type ProviderScope = z.infer<typeof providerScopeSchema>;

/**
 * 实例响应：只有 apiKeyRef 语义的 hasCredential 标记，绝无 key 本体。
 * `headerKeys` 同理——自定义头的**键名**可见，值一律不回显（与 MCP `env`/`envKeys` 同口径）。
 */
export const providerInstanceResponseSchema = z.object({
  id: identifier,
  scope: providerScopeSchema,
  name: z.string().min(1),
  protocol: providerProtocolSchema,
  baseUrl: z.string().optional(),
  hasCredential: z.boolean(),
  models: z.array(providerInstanceModelSchema),
  compat: providerCompatSchema.optional(),
  headerKeys: z.array(z.string()),
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

/**
 * 目录条目的能力 hints（models.dev 快照，docs/future/05 §4）。
 * 非权威 UI 提示：**只携带用户模型行上未声明的字段**（声明过的绝不进 hints，
 * 避免「同一字段两个来源」的歧义）；条目上缺 hints = 快照未收录该模型——
 * 语义是「未知」，不是「不支持」，消费方不得据此降级。
 */
export const modelCatalogHintsSchema = z.object({
  source: z.literal("models-dev"),
  /** 快照内的 provider 键（同 id 多 provider 时按协议偏好命中，出处透出便于复核）。 */
  snapshotProvider: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** 快照输入模态含 image（vision 徽标的补缺来源）。 */
  imageInput: z.boolean().optional(),
  toolCall: z.boolean().optional(),
  reasoning: z.boolean().optional(),
});
export type ModelCatalogHints = z.infer<typeof modelCatalogHintsSchema>;

export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capability: modelCapabilitySchema,
  /** 原始实例模型（vision / contextWindow 透传用）。 */
  model: providerInstanceModelSchema,
  /** models.dev 快照补缺（可选；用户声明永远优先，见 modelCatalogHintsSchema）。 */
  hints: modelCatalogHintsSchema.optional(),
  provider: z.object({
    instanceId: identifier,
    name: z.string().min(1),
    protocol: providerProtocolSchema,
    /** workspace = 用户自带（不计费）；system = 平台池（按 token 计费）。 */
    scope: providerScopeSchema,
  }),
});
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;

export const modelCatalogResponseSchema = z.object({
  models: z.array(modelCatalogEntrySchema),
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
