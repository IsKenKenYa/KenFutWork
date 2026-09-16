import { z } from "zod";

import {
  assetObjectSchema,
  canvasContentSchema,
  canvasDetailSchema,
  chatMessageSchema,
  chatSessionSummarySchema,
  modelInfoSchema,
  projectKindSchema,
  projectSummarySchema,
  runIdSchema,
  viewerProfileSchema,
  workspaceMembershipSchema,
  workspaceSettingsSchema,
  workspaceSummarySchema,
} from "./contracts.js";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("kenfutwork-server"),
  version: z.string().min(1),
});

export const runCancelResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["canceling", "canceled"]),
});

export const viewerCreditsSchema = z.object({
  balance: z.number().int(),
  plan: z.string(),
  dailyClaimed: z.boolean(),
  limits: z.object({
    maxConcurrentJobs: z.number().int(),
    maxResolution: z.string(),
    monthlyCredits: z.number().int(),
    dailyCredits: z.number().int(),
  }),
});

export const viewerResponseSchema = z.object({
  profile: viewerProfileSchema,
  workspace: workspaceSummarySchema,
  membership: workspaceMembershipSchema,
  credits: viewerCreditsSchema.optional(),
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export const projectListQuerySchema = z.object({
  /** 只取该类型的项目；缺省取 design（画布项目）。 */
  kind: projectKindSchema.optional(),
});

export const projectCreateRequestSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  /**
   * 项目类型（默认 design）。Code 模式「工作目录=项目」建 kind='code'，
   * 两端各自按 kind 取列表，避免画布项目与工作目录项目互相串味。
   */
  kind: projectKindSchema.optional(),
});

export const projectCreateResponseSchema = z.object({
  project: projectSummarySchema,
});

export const unauthenticatedErrorResponseSchema = z.object({
  error: z.object({
    code: z.literal("unauthorized"),
    message: z.string().min(1),
  }),
});

// --- Code 模式 git 分支视图（工作目录=项目） ---

export const codeGitBranchSchema = z.object({
  name: z.string().min(1),
  current: z.boolean(),
});

export const codeGitStatusResponseSchema = z.object({
  git: z.object({
    isRepo: z.boolean(),
    branch: z.string().nullable(),
    branches: z.array(codeGitBranchSchema),
    /** 有未提交改动（切分支前提示用）。 */
    dirty: z.boolean(),
    /** 实际使用的 git 来源，便于排查「为什么没有分支可切」。 */
    source: z.enum(["system", "bundled", "unavailable"]),
  }),
});

export const codeGitCheckoutRequestSchema = z.object({
  canvasId: z.string().min(1),
  branch: z.string().min(1),
});

// --- Code 模式 git 写操作（R2-1：更改统计 / 提交 / 推送 / 新建分支） ---

export const codeGitDiffStatResponseSchema = z.object({
  stat: z.object({
    /** 有改动的文件数（含未跟踪）。 */
    files: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    untracked: z.number().int().min(0),
  }),
});

export const codeGitCommitRequestSchema = z.object({
  canvasId: z.string().min(1),
  message: z.string().trim().min(1).max(500),
});

export const codeGitBranchCreateRequestSchema = z.object({
  canvasId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
});

export const applicationErrorCodeSchema = z.enum([
  "application_error",
  /**
   * 依赖的服务/能力未装配或不可用（HTTP 503）。
   * 真机踩过：直连视频生成路由的 `jobService` 从未装配，而该分支写的错误码不在本枚举里
   * ——`parse` 抛错后响应体变成 ZodError 转储，前端只看到一段乱码 JSON。
   */
  "service_unavailable",
  // 自管认证（M1.4）：与 auth-contracts.ts 的 authErrorResponseSchema 同一组码
  "auth_unavailable",
  "email_taken",
  "invalid_credentials",
  "invalid_input",
  // 平台管理后台（FORM-10）
  "forbidden",
  "admin_query_failed",
  "admin_action_failed",
  "user_not_found",
  "invalid_action",
  "bootstrap_failed",
  "brand_kit_not_found",
  "brand_kit_create_failed",
  "brand_kit_update_failed",
  "brand_kit_delete_failed",
  "brand_kit_query_failed",
  "brand_kit_asset_not_found",
  "brand_kit_asset_create_failed",
  "canvas_not_found",
  "canvas_save_failed",
  "chat_error",
  "profile_update_failed",
  "project_query_failed",
  "project_create_failed",
  "project_delete_failed",
  "project_not_found",
  "project_slug_taken",
  "project_update_failed",
  "session_not_found",
  "settings_not_found",
  "settings_update_failed",
  "upload_failed",
  "asset_not_found",
  "job_not_found",
  "job_create_failed",
  "job_query_failed",
  "job_cancel_failed",
  "skill_not_found",
  "skill_create_failed",
  "skill_update_failed",
  "skill_delete_failed",
  "skill_query_failed",
  "skill_install_failed",
  "skill_uninstall_failed",
  "skill_toggle_failed",
  "skill_import_failed",
  "skill_file_query_failed",
  "marketplace_search_failed",
  "marketplace_detail_failed",
  "instance_create_failed",
  "instance_update_failed",
  "instance_delete_failed",
  "instance_query_failed",
  "marketplace_install_failed",
  "insufficient_credits",
  "credit_query_failed",
  "credit_claim_failed",
  "credit_deduct_failed",
  "credit_refund_failed",
  "credit_plan_update_failed",
  "model_not_accessible",
  "resolution_not_allowed",
  "concurrency_limit",
  "variant_not_found",
  "checkout_failed",
  "generation_failed",
  // 插件市场（安装前兼容性门禁 + 启停）
  "invalid_request",
  "plugin_not_found",
  "plugin_source_failed",
  "plugin_incompatible",
  "install_failed",
  "uninstall_failed",
  "toggle_failed",
  "system_plugin",
  "not_installed",
  // Code 模式 git 写操作（R2-1：提交/推送/建分支）
  "git_unavailable",
  "git_write_failed",
  // 用户侧使用统计（R4-2）
  "usage_query_failed",
]);

export const applicationErrorResponseSchema = z.object({
  error: z.object({
    code: applicationErrorCodeSchema,
    message: z.string().min(1),
  }),
});

export const canvasGetResponseSchema = z.object({
  canvas: canvasDetailSchema,
});

export const canvasSaveRequestSchema = z.object({
  content: canvasContentSchema,
});

export const canvasSaveResponseSchema = z.object({
  ok: z.literal(true),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type RunCancelResponse = z.infer<typeof runCancelResponseSchema>;
export type ViewerCredits = z.infer<typeof viewerCreditsSchema>;
export type ViewerResponse = z.infer<typeof viewerResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = z.infer<typeof projectCreateResponseSchema>;
export type UnauthenticatedErrorResponse = z.infer<
  typeof unauthenticatedErrorResponseSchema
>;
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;
export type ApplicationErrorResponse = z.infer<
  typeof applicationErrorResponseSchema
>;
export const profileUpdateResponseSchema = z.object({
  profile: viewerProfileSchema,
});

export const workspaceSettingsResponseSchema = z.object({
  settings: workspaceSettingsSchema,
});

export const workspaceSettingsUpdateRequestSchema = workspaceSettingsSchema;

export const modelListResponseSchema = z.object({
  models: z.array(modelInfoSchema),
});

export const sessionListResponseSchema = z.object({
  sessions: z.array(chatSessionSummarySchema),
});

export const sessionCreateResponseSchema = z.object({
  session: chatSessionSummarySchema,
});

export const messageListResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
});

export const messageCreateResponseSchema = z.object({
  message: chatMessageSchema,
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type SessionCreateResponse = z.infer<typeof sessionCreateResponseSchema>;
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
export type MessageCreateResponse = z.infer<typeof messageCreateResponseSchema>;
export type CanvasGetResponse = z.infer<typeof canvasGetResponseSchema>;
export type CanvasSaveRequest = z.infer<typeof canvasSaveRequestSchema>;
export type CanvasSaveResponse = z.infer<typeof canvasSaveResponseSchema>;
export type ProfileUpdateResponse = z.infer<typeof profileUpdateResponseSchema>;
export type WorkspaceSettingsResponse = z.infer<
  typeof workspaceSettingsResponseSchema
>;
export type WorkspaceSettingsUpdateRequest = z.infer<
  typeof workspaceSettingsUpdateRequestSchema
>;
export type ModelListResponse = z.infer<typeof modelListResponseSchema>;

export const uploadResponseSchema = z.object({
  asset: assetObjectSchema,
  url: z.string().min(1),
});

export const assetSignedUrlResponseSchema = z.object({
  url: z.string().min(1),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type AssetSignedUrlResponse = z.infer<
  typeof assetSignedUrlResponseSchema
>;

export const projectUpdateRequestSchema = z.object({
  brand_kit_id: z.uuid().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
