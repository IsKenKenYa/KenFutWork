import { z } from "zod";

import { toolArtifactSchema } from "./artifacts.js";
import { brandKitAssetTypeSchema } from "./brand-kit-contracts.js";
import { executionModeSchema } from "./capability-contracts.js";
import { governanceBoolSetting, governanceSetting } from "./governance.js";

export const identifierSchema = z.string().min(1);
export const timestampSchema = z.iso.datetime({ offset: true });

export const sessionIdSchema = identifierSchema;
export const conversationIdSchema = identifierSchema;
export const runIdSchema = identifierSchema;
export const messageIdSchema = identifierSchema;
export const toolCallIdSchema = identifierSchema;
export const userIdSchema = identifierSchema;
export const workspaceIdSchema = identifierSchema;
export const projectIdSchema = identifierSchema;
export const canvasIdSchema = identifierSchema;

export const workspaceTypeSchema = z.enum(["personal", "team"]);
export const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);

export const runStatusSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "failed",
]);

export const imageAttachmentSchema = z.object({
  assetId: z.string().min(1),
  url: z.url(),
  mimeType: z.string().min(1),
  name: z.string().min(1).optional(),
});

export const imageModelMentionSchema = z.object({
  mentionType: z.literal("image-model"),
  id: z.string().min(1),
  label: z.string().min(1),
});

export const brandKitAssetMentionSchema = z.object({
  mentionType: z.literal("brand-kit-asset"),
  id: z.string().min(1),
  label: z.string().min(1),
  assetType: brandKitAssetTypeSchema,
  textContent: z.string().nullable().optional(),
  fileUrl: z.url().nullable().optional(),
});

export const skillMentionSchema = z.object({
  mentionType: z.literal("skill"),
  id: z.string().min(1),
  label: z.string().min(1),
  slug: z.string().min(1),
});

export const messageMentionSchema = z.discriminatedUnion("mentionType", [
  imageModelMentionSchema,
  brandKitAssetMentionSchema,
  skillMentionSchema,
]);

export const imageGenerationPreferenceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  models: z.array(z.string().min(1)),
});

export const videoGenerationPreferenceSchema = z.object({
  mode: z.enum(["auto", "manual"]),
  models: z.array(z.string().min(1)),
});

export const runCreateRequestSchema = z.object({
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  prompt: z.string(),
  canvasId: canvasIdSchema.optional(),
  attachments: z.array(imageAttachmentSchema).optional(),
  imageGenerationPreference: imageGenerationPreferenceSchema.optional(),
  videoGenerationPreference: videoGenerationPreferenceSchema.optional(),
  mentions: z.array(messageMentionSchema).optional(),
  accessToken: z.string().optional(),
  model: z.string().optional(),
  /**
   * agent preset（DEC-2，会话级）：design=画布工具集，code=编码工具集；
   * 缺省由服务端推断（有 canvasId → design，否则 code）。
   */
  preset: z.enum(["design", "code"]).optional(),
  /**
   * 执行模式（DEC-3，会话级）：WS 路径随 run 声明，服务端按真实 threadId 激活
   * （threadId 是服务端内部 ID，客户端拿不到，故不走 PUT /execution-modes）。
   */
  executionMode: executionModeSchema.optional(),
});

export const runCreateResponseSchema = z.object({
  runId: runIdSchema,
  sessionId: sessionIdSchema,
  conversationId: conversationIdSchema,
  status: z.literal("accepted"),
});

export const viewerProfileSchema = z.object({
  id: userIdSchema,
  email: z.email(),
  displayName: z.string().min(1),
  avatarUrl: z.url().nullable().optional(),
});

export const workspaceSummarySchema = z.object({
  id: workspaceIdSchema,
  name: z.string().min(1),
  type: workspaceTypeSchema,
  ownerUserId: userIdSchema,
});

export const workspaceMembershipSchema = z.object({
  workspaceId: workspaceIdSchema,
  userId: userIdSchema,
  role: workspaceRoleSchema,
});

export const canvasSummarySchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  isPrimary: z.boolean(),
});

/**
 * 项目类型：design=画布项目（Design 模式），code=工作目录项目（Code 模式
 * 「工作目录=项目」），flow=工作流项目（Flow 模式，可视化 AI 工作流的编排 / 发布 / 执行）。
 * 两端各自按 kind 取列表，各类项目互不串味。
 *
 * flow 子系统的落地节奏（《flow 集成方案》P1）：本阶段只落**契约与库约束**——
 * 类型由服务端一处持有，flow run 同样必绑项目（与 Code 模式同一条硬约束，画布 id 即作用域）；
 * flow 的模式入口与画布随宿主适配层（P2）接通后出现，未接通前界面上不出现空壳入口。
 */
export const projectKindSchema = z.enum(["design", "code", "flow"]);
export type ProjectKind = z.infer<typeof projectKindSchema>;

export const projectSummarySchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  kind: projectKindSchema,
  description: z.string().nullable(),
  /**
   * 绑定的本机工作目录绝对路径（Code 项目）。桌面端由系统文件夹选择器给出，
   * Web 端由「填本机路径」手填；为空表示走沙箱目录 `<sandboxRoot>/<canvasId>`。
   */
  workDir: z.string().min(1).nullable().optional(),
  thumbnailUrl: z.string().nullable().optional(),
  workspace: workspaceSummarySchema,
  primaryCanvas: canvasSummarySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const canvasContentSchema = z.object({
  elements: z.array(z.record(z.string(), z.unknown())).default([]),
  appState: z.record(z.string(), z.unknown()).default({}),
  files: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export const canvasDetailSchema = z.object({
  id: canvasIdSchema,
  name: z.string().min(1),
  projectId: projectIdSchema,
  content: canvasContentSchema,
});

export const profileUpdateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});

/**
 * 右栏「终端」用的 shell（`auto` = 按平台取默认：Windows → cmd，POSIX → sh）。
 *
 * **封闭集合**：服务端只认这些 id，写错在写入时就被拦下；本机有没有某个 shell 由服务端
 * 探测（换台机器可能没有 PowerShell 7），设置的默认值落回平台默认而不是报错。
 */
export const terminalShellSchema = z.enum([
  "auto",
  "cmd",
  "powershell",
  "pwsh",
  "git-bash",
  "bash",
  "sh",
]);

export type TerminalShellId = z.infer<typeof terminalShellSchema>;

export const workspaceSettingsSchema = z.object({
  defaultModel: z.string().min(1),
  /** 终端默认 shell（用户口径：「可以在设置里配置默认的」）。 */
  terminalShell: terminalShellSchema.default("auto"),
  /**
   * R4-3「索引存储库以实现即时搜索」（索引文件是本机缓存，不进库表）。
   * 关掉时右栏「文件目录」的搜索**如实拒绝并指路**，不是回空列表。
   */
  codeIndexEnabled: z.boolean().default(false),
  /**
   * R4-3「索引新文件夹」：搜到还没有索引的工作目录时**自动建一份**，
   * 目录文件数达到 50,000 就不自动建（如实说明并指路「手动重建」）。
   * 只在 {@link codeIndexEnabled} 开着时起作用——两行开关对应参考图的真实行为。
   */
  codeIndexAutoNewFolder: z.boolean().default(true),
  /**
   * 用户规则（设置 → 规则与记忆）：**每轮 run 都会拼进系统提示词**（服务端有消费方）。
   * 此前只存在浏览器 localStorage，页面文案承诺了「附加到每次请求」却没人读。
   */
  userRules: z.string().max(20_000).default(""),
  /** 逐条规则（短句，最多 100 条）。 */
  ruleEntries: z.array(z.string().min(1).max(2_000)).max(100).default([]),
  /**
   * 用户钩子（设置 →「钩子」）：每一轮 run 的起点 / 终点在**项目工作目录**里跑一条命令。
   *
   * 三条口径：① 只有用户能配置，**模型无法新增或触发**（不进工具注册表、不受工具门管）；
   * ② 执行身份与目录同终端/agent；③ 失败**不阻断**本轮，输出与退出码如实进转录。
   */
  hooks: z
    .array(
      z.object({
        /** 钩子点：本轮开始 / 本轮结束。 */
        event: z.enum(["turn-start", "turn-end"]),
        command: z.string().trim().min(1).max(2_000),
      }),
    )
    .max(10)
    .default([]),
  /**
   * 自定义斜杠命令（设置 →「命令」）：输入框里 `/name 参数` 触发，提交前展开成 prompt。
   *
   * 名字限字母数字与连字符（避免与内置 `/` 行为/路径冲突），最多 50 条。
   */
  commands: z
    .array(
      z.object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/, {
            message: "命令名只能用字母、数字与连字符，且以字母或数字开头。",
          }),
        /** 说明（在设置页与输入框提示里显示）。 */
        description: z.string().trim().max(200).default(""),
        /** 提示词模板；`{{args}}` 会被替换成命令后面的参数（没有占位符则把参数追加到末尾）。 */
        prompt: z.string().trim().min(1).max(4_000),
      }),
    )
    .max(50)
    .default([]),
  /**
   * 上下文自动压缩：超阈值时把较早的消息摘要掉（阈值 = 窗口 − 预留输出，摘要用本轮模型，
   * 用户转录不变、原文 offload 到工作区 /conversation_history/）。关掉时中间件不挂。
   */
  autoCompactEnabled: z.boolean().default(true),
  /**
   * run 失败自动重试上限（含首次尝试；0 = 不重试）。
   * 缺省 10；服务端对「已执行工具」的轮次一律不重试（副作用安全），见 agent/run-retry.ts。
   */
  agentMaxRetries: z.number().int().min(0).max(50).default(10),
  /**
   * agent 治理可调数值（DEC-17/DEC-18）：以下五项的唯一字面量属主是 shared
   * `governance.ts`（`AGENT_GOVERNANCE_DEFAULTS`），覆盖入口 = workspace_settings
   * （本 schema 的设置页 PATCH）+ env 兜底；服务端读侧另有 clamp 护栏。
   */
  /** 子代理派生深度上限：1 = 子代理不得再派生（禁孙代理）。 */
  subagentMaxDepth: governanceSetting("subagentMaxDepth"),
  /** 后台任务（子代理/长命令）同时运行上限。 */
  subagentMaxConcurrency: governanceSetting("subagentMaxConcurrency"),
  /** 轮末闸门续轮上限：防挂死后台任务导致无限续轮。 */
  subagentMaxContinuations: governanceSetting("subagentMaxContinuations"),
  /** LLM 请求级重试上限（含首次；0 = 不重试；治上游 429/5xx 抖动）。 */
  llmRequestMaxRetries: governanceSetting("llmRequestMaxRetries"),
  /** LLM 请求无限重试（用户显式开启；持续 429 的不稳定上游场景）。 */
  llmInfiniteRetry: governanceBoolSetting("llmInfiniteRetry"),
  /** Code 模式 execute 命令超时（毫秒；下限 5s 上限 30min）。 */
  executeTimeoutMs: governanceSetting("executeTimeoutMs"),
});

export const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  /** 标识用户供应商实例（BYOK，§5）；内置目录无实例时缺省。 */
  providerInstanceId: z.string().min(1).optional(),
  /** 实例显示名（BYOK 分组头用）；内置目录缺省。 */
  providerName: z.string().min(1).optional(),
  /** 支持图像输入（前端「视觉」徽标）。 */
  vision: z.boolean().optional(),
  /** 上下文窗口 token 数（前端量级徽标）。 */
  contextWindow: z.number().int().positive().optional(),
  /** 单次回复最大输出 token 数（上下文条「预留输出」段的来源，见 provider-contracts）。 */
  maxOutputTokens: z.number().int().positive().optional(),
  /** 思考档位声明（实例模型行的 reasoningEfforts；缺席 = 全档位可选）。 */
  reasoningEfforts: z.array(z.string().min(1)).optional(),
});

export const chatSessionIdSchema = identifierSchema;

export const chatToolActivitySchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["running", "completed"]),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
});

export const chatSessionSummarySchema = z.object({
  id: chatSessionIdSchema,
  title: z.string(),
  updatedAt: timestampSchema,
});

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  /** 该段正文第一个字到达的时刻（ISO；服务端组装时打点，轨迹时间轴用）。 */
  at: timestampSchema.optional(),
});

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  /** 该段思考第一个字到达的时刻（ISO）。 */
  at: timestampSchema.optional(),
});

export const toolBlockSchema = z.object({
  type: z.literal("tool"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(["running", "completed"]),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  outputSummary: z.string().optional(),
  artifacts: z.array(toolArtifactSchema).optional(),
  /**
   * 归属的 run（一次请求）：对话历史落库后刷新，界面据此回答「这次调用属于哪轮
   * 对话」并按轮折叠/分账本。旧数据无此字段（可选向前兼容）。
   */
  runId: z.string().min(1).optional(),
  /** 起止时刻（ISO）：轨迹账本的时间列与耗时列的数据源；旧数据无此字段。 */
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  /** 子代理归因（DEC-19）：该调用发生在哪个具名子代理里；主 agent 调用缺省。 */
  agentName: z.string().min(1).optional(),
  /** 派发调用 id：渲染层据此把子代理内部工具路由进子代理视图，不进主对话。 */
  agentCallId: z.string().min(1).optional(),
});

/**
 * 后台任务通知块（DEC-15）：后台子代理 / 长命令的终态通知在转录里的落库形态。
 * 与 `task.notification` 流事件同源（服务端同一份事实写两处：事件管实时、块管回放），
 * 渲染为静默通知行，不是 assistant 正文也不是工具行。
 */
export const taskNotificationBlockSchema = z.object({
  type: z.literal("task_notification"),
  taskId: z.string().min(1).max(128),
  kind: z.enum(["subagent", "command"]),
  label: z.string().min(1).max(2_000),
  status: z.enum(["completed", "failed", "canceled"]),
  summary: z.string().min(1).max(8_000),
  nextStep: z.string().max(2_000).optional(),
  /** 派发调用 id：后台子代理结算时据此关掉目录条目。 */
  agentCallId: z.string().min(1).optional(),
  /** 通知产生时刻（ISO）。 */
  at: timestampSchema.optional(),
});

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  assetId: z.string().min(1),
  url: z.url(),
  mimeType: z.string().min(1),
  source: z.enum(["upload", "canvas-ref"]),
  name: z.string().min(1).optional(),
});

export const imageModelMentionBlockSchema = z.object({
  type: z.literal("mention"),
  mentionType: z.literal("image-model"),
  id: z.string().min(1),
  label: z.string().min(1),
});

export const brandKitAssetMentionBlockSchema = z.object({
  type: z.literal("mention"),
  mentionType: z.literal("brand-kit-asset"),
  id: z.string().min(1),
  label: z.string().min(1),
  assetType: brandKitAssetTypeSchema,
  textContent: z.string().nullable().optional(),
  fileUrl: z.url().nullable().optional(),
});

export const skillMentionBlockSchema = z.object({
  type: z.literal("mention"),
  mentionType: z.literal("skill"),
  id: z.string().min(1),
  label: z.string().min(1),
  slug: z.string().min(1),
});

export const mentionBlockSchema = z.union([
  imageModelMentionBlockSchema,
  brandKitAssetMentionBlockSchema,
  skillMentionBlockSchema,
]);

export const contentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  toolBlockSchema,
  imageBlockSchema,
  mentionBlockSchema,
  taskNotificationBlockSchema,
]);

export const chatMessageSchema = z.object({
  id: identifierSchema,
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolActivities: z.array(chatToolActivitySchema).nullable().optional(),
  contentBlocks: z.array(contentBlockSchema).nullable().optional(),
  createdAt: timestampSchema,
});

export const chatMessageCreateRequestSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  toolActivities: z.array(chatToolActivitySchema).nullable().optional(),
  contentBlocks: z.array(contentBlockSchema).nullable().optional(),
});

export const assetBucketSchema = z.enum(["project-assets", "user-avatars"]);

export const assetObjectSchema = z.object({
  id: identifierSchema,
  bucket: assetBucketSchema,
  objectPath: z.string().min(1),
  mimeType: z.string().min(1).nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  workspaceId: workspaceIdSchema,
  projectId: projectIdSchema.nullable(),
  createdAt: timestampSchema,
});

export type AssetBucket = z.infer<typeof assetBucketSchema>;
export type AssetObject = z.infer<typeof assetObjectSchema>;

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type ToolBlock = z.infer<typeof toolBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type MessageMention = z.infer<typeof messageMentionSchema>;
export type MentionBlock = z.infer<typeof mentionBlockSchema>;
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export type ImageGenerationPreference = z.infer<
  typeof imageGenerationPreferenceSchema
>;
export type VideoGenerationPreference = z.infer<
  typeof videoGenerationPreferenceSchema
>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatMessageCreateRequest = z.infer<
  typeof chatMessageCreateRequestSchema
>;
export type ChatToolActivity = z.infer<typeof chatToolActivitySchema>;
export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type RunCreateRequest = z.infer<typeof runCreateRequestSchema>;
export type RunCreateResponse = z.infer<typeof runCreateResponseSchema>;
export type ViewerProfile = z.infer<typeof viewerProfileSchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;
export type CanvasSummary = z.infer<typeof canvasSummarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type CanvasContent = z.infer<typeof canvasContentSchema>;
export type CanvasDetail = z.infer<typeof canvasDetailSchema>;
