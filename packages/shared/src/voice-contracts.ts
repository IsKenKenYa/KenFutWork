import { z } from "zod";

/**
 * 语音助手契约（《语音助手插件规划》§2.4）。
 *
 * 错误码**不动**封闭集合（`applicationErrorCodeSchema`）：未装/不可用 → `service_unavailable`
 * （503）；音频非法或超限 → `invalid_input`（400）。历史事故：新码不在枚举里时响应会退化成
 * ZodError 转储，前端只看到一段乱码 JSON。
 *
 * 副作用与幂等：转写与改写**不落库、不动余额、不写用量**，按 `AGENTS.md`「持久副作用与
 * 幂等性」按 `unsafe` 处理（HTTP 层不自动重试）。
 */

/** 三段（规划 §3）：听（ASR）/ 想（意图改写）/ 说（TTS）。三段独立可调、可混搭。 */
export const voiceSegmentKindSchema = z.enum(["listen", "think", "speak"]);
export type VoiceSegmentKind = z.infer<typeof voiceSegmentKindSchema>;

/** 功能模式（规划 §4）：transcribe = 只转文本（**默认档**）/ loop = 完整回路「听→想→说」。 */
export const voiceModeSchema = z.enum(["transcribe", "loop"]);
export type VoiceMode = z.infer<typeof voiceModeSchema>;

/**
 * 一段的模型选择。两种来源**显式区分**（不用字符串前缀猜）：
 * - `builtin`：内置离线模型，`id` 是模型目录 id（落 `<数据目录>/models/<id>/`），需下载；
 * - `instance`：BYOK 供应商实例，`id` 是实例 id，`model` 是实例内模型 id
 *   （一个实例可能既有 whisper-1 又有 tts-1，故必须显式给模型，不能靠能力猜）。
 */
export const voiceSelectionSchema = z.object({
  kind: z.enum(["builtin", "instance"]),
  id: z.string().min(1),
  model: z.string().min(1).optional(),
  /** 音色（说段）：内置是 speaker id，远端是 voice 名。 */
  voice: z.string().min(1).optional(),
});
export type VoiceSelection = z.infer<typeof voiceSelectionSchema>;

export const voiceSettingsSchema = z.object({
  mode: voiceModeSchema.default("transcribe"),
  listen: voiceSelectionSchema.nullable().default(null),
  think: voiceSelectionSchema.nullable().default(null),
  speak: voiceSelectionSchema.nullable().default(null),
  /** 方案 B 的语音播报开关（规划 §4.2「可选」）。 */
  speakReplies: z.boolean().default(false),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const voiceSettingsResponseSchema = z.object({
  settings: voiceSettingsSchema,
});
export type VoiceSettingsResponse = z.infer<typeof voiceSettingsResponseSchema>;

/**
 * PUT 是**部分更新**：字段一律**不带** `.default(...)`。
 * 历史事故：带默认值的字段经 `.partial()` 后依然会产出默认值，于是「改一个开关把其余
 * 设置静默重置」（详见 `http.ts` 里 `withoutDefaults` 的注释）。这里直接不带默认值。
 */
export const voiceSettingsUpdateRequestSchema = z.object({
  mode: voiceModeSchema.optional(),
  listen: voiceSelectionSchema.nullable().optional(),
  think: voiceSelectionSchema.nullable().optional(),
  speak: voiceSelectionSchema.nullable().optional(),
  speakReplies: z.boolean().optional(),
});
export type VoiceSettingsUpdateRequest = z.infer<
  typeof voiceSettingsUpdateRequestSchema
>;

/** 转写结果（规划 §2.3）。空文本是**正常结果**（用户没说），不是错误。 */
export const voiceTranscribeResponseSchema = z.object({ text: z.string() });
export type VoiceTranscribeResponse = z.infer<
  typeof voiceTranscribeResponseSchema
>;

/** 合成结果的 mimeType（浏览器 `decodeAudioData` 直接能解）。 */
export const voiceSpeakResponseAudioMime = "audio/wav";

/**
 * 模型目录条目（规划 §5）：三段的候选都来自这一张表，界面按它出卡片。
 * 字段就是卡片上要显示的东西——来源、体积、运行位置、是否需下载、性能标注。
 */
export const voiceModelCandidateSchema = z.object({
  /** 选择器里存的 id：builtin 是模型目录 id，instance 是供应商实例 id。 */
  id: z.string().min(1),
  segment: voiceSegmentKindSchema,
  label: z.string().min(1),
  /** builtin = 需下载的离线模型；instance = 现成端点（零下载）。 */
  kind: z.enum(["builtin", "instance"]),
  location: z.enum(["cpu", "gpu", "remote"]),
  /** 仅 instance：实例内的模型 id（选择时一并存下）。 */
  model: z.string().min(1).optional(),
  /** 体积（字节）；端点候选取 0（不占本机磁盘）。 */
  sizeBytes: z.number().int().nonnegative(),
  needsDownload: z.boolean(),
  /** 下载进度：`state=downloading` 时由前端轮询本接口读进度。 */
  download: z.object({
    state: z.enum(["ready", "missing", "downloading"]),
    downloadedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    /** 上次尝试的失败原因（成功或未开始时为空）。 */
    error: z.string().optional(),
  }),
  /**
   * 不可选的原因；缺席 = 可选。规划 §6 的硬规则：只有硬缺失才置灰，
   * 且置灰必须写明为什么（不摆空壳、不放假开关）。
   */
  unavailableReason: z.string().optional(),
  /** 性能标注：未实测一律标「预估」（规划 §5）。 */
  performanceNote: z.string().optional(),
  /** 许可与署名（内置离线模型需要；规划 §10 风险 7）。 */
  license: z.string().optional(),
});
export type VoiceModelCandidate = z.infer<typeof voiceModelCandidateSchema>;

export const voiceModelListResponseSchema = z.object({
  models: z.array(voiceModelCandidateSchema),
});
export type VoiceModelListResponse = z.infer<typeof voiceModelListResponseSchema>;

export const voiceModelResponseSchema = z.object({
  model: voiceModelCandidateSchema,
});
export type VoiceModelResponse = z.infer<typeof voiceModelResponseSchema>;

/** 下载是**文件系统副作用**，但可重放：校验和不匹配即失败且不留半截文件。 */
export const voiceModelDownloadParamsSchema = z.object({
  modelId: z.string().min(1),
});


// --- 性能检测（规划 §6） ---

/** 硬件面：CPU / 内存 / GPU（nvidia-smi 尽力探测，探不到不影响功能）。 */
export const voiceDiagnoseHardwareSchema = z.object({
  cpuModel: z.string().min(1),
  cpuCores: z.number().int().positive(),
  totalMemoryBytes: z.number().int().positive(),
  platform: z.string().min(1),
  /** 探到的 GPU 描述；缺席 = 没探到（不是错误）。 */
  gpu: z.string().optional(),
});
export type VoiceDiagnoseHardware = z.infer<typeof voiceDiagnoseHardwareSchema>;

/**
 * 一段的检测结论。三态：
 * - `measured`：有实测读数（`metrics` 必填）；
 * - `pending`：链路可用但**还没有实测**（如「听」还没说过话）——给可读引导；
 * - `unavailable`：硬缺失（模型未下载 / 未选模型 / 未接线），`reason` 说明为什么。
 * 规划 §6 的硬规则：性能不足只是警告，**只有硬缺失才置灰**。
 */
export const voiceDiagnoseSegmentSchema = z.object({
  state: z.enum(["measured", "pending", "unavailable"]),
  summary: z.string().min(1),
  /** 听：稳态中位实时率 + 首次载入耗时。 */
  listen: z
    .object({
      rtfMedian: z.number().nonnegative().optional(),
      samples: z.number().int().nonnegative(),
      modelLoadMs: z.number().nonnegative().optional(),
      lastClipSeconds: z.number().positive().optional(),
    })
    .optional(),
  /** 想：首 token 延迟（语音回路真正在意的读数）+ 可选生成速度。 */
  think: z
    .object({
      ttftSeconds: z.number().nonnegative(),
      tokensPerSecond: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type VoiceDiagnoseSegment = z.infer<typeof voiceDiagnoseSegmentSchema>;

export const voiceDiagnoseReportSchema = z.object({
  hardware: voiceDiagnoseHardwareSchema,
  listen: voiceDiagnoseSegmentSchema,
  think: voiceDiagnoseSegmentSchema,
  speak: voiceDiagnoseSegmentSchema,
  /** 报告时间（ISO）；读回上次结果时靠它显示「多久之前测的」。 */
  measuredAt: z.iso.datetime({ offset: true }),
});
export type VoiceDiagnoseReport = z.infer<typeof voiceDiagnoseReportSchema>;

/** POST /api/voice/diagnose 的响应；`report` 为 null 表示还没测过。 */
export const voiceDiagnoseResponseSchema = z.object({
  report: voiceDiagnoseReportSchema.nullable(),
});
export type VoiceDiagnoseResponse = z.infer<typeof voiceDiagnoseResponseSchema>;

// --- 方案 B：把口述补成完整需求（规划 §4.2 / §4.3） ---

/** 会话上下文条目（只带最近几条，用于消解「刚才那个按钮」这类指代）。 */
export const voiceRefineContextMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});
export type VoiceRefineContextMessage = z.infer<
  typeof voiceRefineContextMessageSchema
>;

/** 上下文条数上限：指代消解够用即可，别把整段会话塞进去。 */
export const VOICE_REFINE_CONTEXT_LIMIT = 6;

export const voiceRefineRequestSchema = z.object({
  /** 口述转写出来的文本。 */
  text: z.string().min(1).max(4_000),
  recentMessages: z
    .array(voiceRefineContextMessageSchema)
    .max(VOICE_REFINE_CONTEXT_LIMIT)
    .optional(),
});
export type VoiceRefineRequest = z.infer<typeof voiceRefineRequestSchema>;

/**
 * 完整需求（**实际会被发出的那段话**）。
 * 规划 §4.3 第 1 条：转录里展示的就是真发出去的，不做「显示一套、发另一套」。
 */
export const voiceRefineResponseSchema = z.object({ prompt: z.string() });
export type VoiceRefineResponse = z.infer<typeof voiceRefineResponseSchema>;

// --- 方案 B 的「说」段：语音播报回复（规划 §4.2 / §7） ---

/** 播报请求：文本就是**将要念出来的那段**（不截断、不加工）。 */
export const voiceSpeakRequestSchema = z.object({
  text: z.string().min(1).max(4_000),
});
export type VoiceSpeakRequest = z.infer<typeof voiceSpeakRequestSchema>;

/** 播报响应是**音频字节**（不是 JSON）：content-type 由 provider 决定（默认 audio/wav）。 */
export const VOICE_SPEAK_MAX_CHARS = 500;
