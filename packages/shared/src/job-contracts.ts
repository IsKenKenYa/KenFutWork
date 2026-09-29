import { z } from "zod";

// --- Enums ---

export const backgroundJobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "dead_letter",
]);
export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusSchema>;

export const backgroundJobTypeSchema = z.enum([
  "image_generation",
  "video_generation",
]);
export type BackgroundJobType = z.infer<typeof backgroundJobTypeSchema>;

// --- Payloads ---

export const imageGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  /** BYOK：任务携带的用户供应商实例 id（§5），worker 按其实例化协议适配器。 */
  provider_instance_id: z.string().optional(),
  aspect_ratio: z.string().optional(),
});
export type ImageGenerationPayload = z.infer<
  typeof imageGenerationPayloadSchema
>;

export const videoGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  /** BYOK：任务携带的用户供应商实例 id（§5），worker 按其实例化协议适配器。 */
  provider_instance_id: z.string().optional(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
});
export type VideoGenerationPayload = z.infer<
  typeof videoGenerationPayloadSchema
>;

export const createVideoJobRequestSchema = z.object({
  project_id: z.uuid().optional(),
  canvas_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
});
export type CreateVideoJobRequest = z.infer<typeof createVideoJobRequestSchema>;

// --- Job entity ---

export const backgroundJobSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  project_id: z.uuid().nullable(),
  canvas_id: z.uuid().nullable(),
  session_id: z.uuid().nullable(),
  thread_id: z.string().nullable(),
  queue_name: z.string(),
  job_type: backgroundJobTypeSchema,
  status: backgroundJobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  /** 外部厂商任务引用（submit 成功落库；崩溃恢复据此续 poll）。 */
  provider_job_id: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
});
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

// --- API Request schemas ---

export const createImageJobRequestSchema = z.object({
  project_id: z.uuid().optional(),
  canvas_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().optional(),
  aspect_ratio: z.string().optional(),
});
export type CreateImageJobRequest = z.infer<typeof createImageJobRequestSchema>;

// 同步生成（http/generate.ts，直连 BYOK 实例不走队列）的请求契约：原先定义在路由文件本地，
// 为让 API 文档管线（openapi/registry.ts）保持「契约一律出自 shared」而迁入。
export const generateImageRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  /** BYOK：用户供应商实例 id；携带时按实例实例化协议适配器（P4）。 */
  providerInstanceId: z.string().uuid().optional(),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  quality: z.enum(["standard", "hd", "ultra"]).optional(),
  /**
   * 参考图（URL / data URL / 裸 base64）：非空时适配器走 `/images/edits`
   * （参考图编辑/inpainting），空缺省仍走 `/images/generations`。
   */
  inputImages: z.array(z.string().min(1)).max(4).optional(),
  /**
   * 会话标识（§4.8 自定义头占位符的渲染上下文）：画布助手发起时带上当前会话，
   * 使 `{{sessionId}}` 能取到值；确无会话的调用方可缺省（实例若配了占位符会 fail loud）。
   * **口径与 run 路径一致**（`sessionIdSchema` = 非空字符串）——Code 模式的会话 id 是
   * 客户端自造的，按 uuid 校验会把合法值挡在门外。
   */
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});
export type GenerateImageRequest = z.infer<typeof generateImageRequestSchema>;

export const generateVideoRequestSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  /** BYOK：用户供应商实例 id；携带时任务载荷透传，worker 按实例实例化适配器。 */
  providerInstanceId: z.string().uuid().optional(),
  duration: z.number().int().min(3).max(16).optional(),
  resolution: z.enum(["720p", "1080p", "4k"]).optional(),
  aspectRatio: z.enum(["16:9", "9:16"]).optional(),
  inputImages: z.array(z.string()).max(3).optional(),
  /** 会话标识：随 job 行落库，worker 侧按同一口径渲染自定义头（§4.8）。口径同 run 路径。 */
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});
export type GenerateVideoRequest = z.infer<typeof generateVideoRequestSchema>;

// --- API Response schemas ---

export const jobResponseSchema = z.object({
  job: backgroundJobSchema,
});
export type JobResponse = z.infer<typeof jobResponseSchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;
