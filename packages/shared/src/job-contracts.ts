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
  model: z.string().min(1),
  /** BYOK：任务携带的本地供应商实例 id（§5），worker 按其实例化协议适配器。 */
  provider_instance_id: z.uuid(),
  aspect_ratio: z.string().optional(),
});
export type ImageGenerationPayload = z.infer<
  typeof imageGenerationPayloadSchema
>;

export const videoGenerationPayloadSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().min(1),
  /** BYOK：任务携带的本地供应商实例 id（§5），worker 按其实例化协议适配器。 */
  provider_instance_id: z.uuid(),
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
  request_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  canvas_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().min(1),
  provider_instance_id: z.uuid(),
  duration: z.number().int().optional(),
  resolution: z.string().optional(),
  aspect_ratio: z.string().optional(),
  input_images: z.array(z.string()).optional(),
  input_video: z.string().optional(),
  enable_audio: z.boolean().optional(),
});
export type CreateVideoJobRequest = z.infer<typeof createVideoJobRequestSchema>;

// --- Job entity ---

/** 服务端接纳时固定的成果归属，不随关联外键被清空而改变。 */
export const generationFileTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standalone") }).strict(),
  z
    .object({
      kind: z.literal("project"),
      projectId: z.uuid(),
      sessionId: z.uuid().nullable(),
      canvasId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      taskId: z.uuid(),
      projectId: z.uuid(),
      sessionId: z.uuid(),
      canvasId: z.uuid().optional(),
      /** 明确null表示鉴权交互式来源；Agent须保存真实Run身份。 */
      originRunId: z.string().min(1).nullable().optional(),
      scopeGeneration: z.number().int().nonnegative(),
      branchGeneration: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type GenerationFileTarget = z.infer<typeof generationFileTargetSchema>;

/** 单个已保存产物；一个Job可有多个产物，部分失败仍保留成功项。 */
export const generationOutputSchema = z.object({
  asset_id: z.string().min(1),
  object_path: z.string().min(1),
  signed_url: z.string(),
  mime_type: z.string().min(1),
  width: z.number().optional(),
  height: z.number().optional(),
  duration_seconds: z.number().optional(),
  element_id: z.string().optional(),
});
export type GenerationOutput = z.infer<typeof generationOutputSchema>;

export const backgroundJobResultSchema = z
  .object({ outputs: z.array(generationOutputSchema).optional() })
  .catchall(z.unknown());

export const backgroundJobSchema = z.object({
  id: z.uuid(),
  instance_id: z.uuid(),
  project_id: z.uuid().nullable(),
  canvas_id: z.uuid().nullable(),
  session_id: z.uuid().nullable(),
  thread_id: z.string().nullable(),
  /** 只读来源事实；历史缺失的队列记录不得推定为独立生成或自动重放。 */
  file_target: generationFileTargetSchema.nullable().optional(),
  queue_name: z.string(),
  job_type: backgroundJobTypeSchema,
  status: backgroundJobStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  /** 外部厂商任务引用（submit 成功落库；崩溃恢复据此续 poll）。 */
  provider_job_id: z.string().nullable(),
  result: backgroundJobResultSchema.nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  attempt_count: z.number().int(),
  max_attempts: z.number().int(),
  created_by_client_id: z.uuid().nullable(),
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
  request_id: z.uuid().optional(),
  project_id: z.uuid().optional(),
  canvas_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  thread_id: z.string().optional(),
  prompt: z.string().min(1),
  model: z.string().min(1),
  provider_instance_id: z.uuid(),
  aspect_ratio: z.string().optional(),
});
export type CreateImageJobRequest = z.infer<typeof createImageJobRequestSchema>;

const generationTargetFields = {
  requestId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  canvasId: z.uuid().optional(),
  generatorId: z.string().min(1).optional(),
  placement: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
};

// 现有画布生成器的异步Job接纳契约；请求标识和冻结文档目标随Job持久化。
export const generateImageRequestSchema = z.object({
  ...generationTargetFields,
  count: z.number().int().positive().default(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  /** BYOK：本地供应商实例 id；携带时按实例实例化协议适配器（P4）。 */
  providerInstanceId: z.string().uuid().optional(),
  aspectRatio: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  outputFormat: z.enum(["png", "jpg", "webp"]).optional(),
  /**
   * 参考图（URL / data URL / 裸 base64）：非空时适配器走 `/images/edits`
   * （参考图编辑/inpainting），空缺省仍走 `/images/generations`。
   */
  inputImages: z.array(z.string().min(1)).optional(),
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
  ...generationTargetFields,
  prompt: z.string().min(1),
  model: z.string().min(1),
  /** BYOK：本地供应商实例 id；携带时任务载荷透传，worker 按实例实例化适配器。 */
  providerInstanceId: z.string().uuid().optional(),
  duration: z.number().int().positive().optional(),
  resolution: z.string().min(1).optional(),
  aspectRatio: z.string().min(1).optional(),
  inputImages: z.array(z.string().min(1)).optional(),
  inputVideo: z.string().min(1).optional(),
  enableAudio: z.boolean().optional(),
  /** 会话标识：随 job 行落库，worker 侧按同一口径渲染自定义头（§4.8）。口径同 run 路径。 */
  sessionId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});
export type GenerateVideoRequest = z.infer<typeof generateVideoRequestSchema>;

// --- API Response schemas ---

export const generationSubmissionSchema = z.object({
  request_id: z.uuid(),
  jobs: z
    .array(z.object({ job_id: z.uuid(), status: backgroundJobStatusSchema }))
    .min(1),
});
export type GenerationSubmission = z.infer<typeof generationSubmissionSchema>;

export const jobResponseSchema = z.object({
  job: backgroundJobSchema,
});
export type JobResponse = z.infer<typeof jobResponseSchema>;

export const jobListResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobListResponse = z.infer<typeof jobListResponseSchema>;

/** 视频通道的输出规格，与账户套餐无关。 */
export type VideoResolution = "720p" | "1080p" | "4k";
