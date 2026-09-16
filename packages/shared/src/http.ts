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
  terminalShellSchema,
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

/**
 * git 图谱（R2-1 条目 6）：`git log --graph --oneline --decorate --all` 的图形行。
 *
 * 服务端**不解析**图形（`*` / `|` / `\` 这些字符本身就是画法），原样给前端用等宽字体渲染；
 * 只额外给两个判断：`isRepo`（非仓库时前端显示初始化引导）与 `truncated`（历史比条数上限更长）。
 */
/**
 * git 图谱（参考图 `git图谱.png`）：独立窗口里的 图/描述/日期/作者/提交 表格。
 * 服务端**不解析图形语义**，只把每行的图形字符与结构化字段分行给出（连接线行也保留，
 * 否则分支图形会缺笔画）。
 */
export const codeGitGraphEntrySchema = z.object({
  /** 该行的图形字符（`*`、`|`、`|\`…），界面按等宽渲染成「图」列。 */
  rail: z.string(),
  /** 提交行才有；连接线行为 null。 */
  sha: z.string().nullable(),
  shortSha: z.string().nullable(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  /** ref 装饰（HEAD / main / origin/main…）。 */
  refs: z.array(z.string()),
  /** 父提交短 sha（详情面板用）。 */
  parents: z.array(z.string()),
});

export const codeGitGraphResponseSchema = z.object({
  graph: z.object({
    isRepo: z.boolean(),
    /** 逐行数据；无提交时为空数组（不是错误）。 */
    entries: z.array(codeGitGraphEntrySchema),
    truncated: z.boolean(),
  }),
});

// --- Code 模式变更清单 / 单文件差异 / 单文件内容（R3-2、R3-3 共用） ---

export const codeGitChangedFileSchema = z.object({
  path: z.string().min(1),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** 二进制文件没有行数概念：`additions`/`deletions` 恒为 0。 */
  binary: z.boolean(),
  status: z.enum(["modified", "added", "deleted", "renamed", "untracked"]),
  /** 已进索引（审查视图据此标「已暂存」并决定按钮文案）。 */
  staged: z.boolean(),
});

/** 「审查」里的暂存/取消暂存（参考图审查视图的「暂存」）。 */
export const codeGitStageRequestSchema = z.object({
  canvasId: z.string().min(1),
  path: z.string().min(1).max(1000),
  staged: z.boolean(),
});

/** 暂存 / 取消暂存**一个块**（参考图审查视图的「暂存块」）。 */
export const codeGitStageHunkRequestSchema = z.object({
  canvasId: z.string().min(1),
  /** 这个块属于哪个文件（服务端会核对 patch 里改的确实只有它）。 */
  path: z.string().min(1).max(1000),
  /** 「文件头 + 这一块」的 patch 文本（由审查视图从 diff 里切出来）。 */
  patch: z.string().min(1).max(200_000),
  /** true = 反向应用（取消暂存这一块）。 */
  reverse: z.boolean().optional(),
});

export const codeGitStageResponseSchema = z.object({
  path: z.string(),
  staged: z.boolean(),
});

export const codeGitChangesResponseSchema = z.object({
  changes: z.object({
    isRepo: z.boolean(),
    files: z.array(codeGitChangedFileSchema),
    /** 变更文件数超过上限（只列前 N 个）。 */
    truncated: z.boolean(),
  }),
});

export const codeGitDiffResponseSchema = z.object({
  diff: z.object({
    path: z.string().min(1),
    /** 统一 diff 文本；未跟踪文件是「按新增行」的合成视图，界面要如实标注。 */
    text: z.string(),
    truncated: z.boolean(),
    untracked: z.boolean(),
  }),
});

// --- 工作目录的文件目录（R3-1「文件目录」标签） ---

export const codeFileEntrySchema = z.object({
  name: z.string().min(1),
  /** 相对工作目录的路径（点进去时原样回传）。 */
  path: z.string(),
  type: z.enum(["file", "dir"]),
  /** 目录为 null。 */
  bytes: z.number().int().nonnegative().nullable(),
});

export const codeFilesResponseSchema = z.object({
  files: z.object({
    /** 列的是哪个目录（相对工作目录；根目录是空串）。 */
    path: z.string(),
    entries: z.array(codeFileEntrySchema),
    /** 条目数超上限（只列前 N 项）。 */
    truncated: z.boolean(),
  }),
});

// --- 右栏终端（R3-1「终端」标签）：在画布工作目录里跑用户命令 ---

export const codeTerminalRequestSchema = z.object({
  canvasId: z.string().min(1),
  command: z.string().trim().min(1).max(4000),
  /** 本次用的 shell；缺省用工作区设置的默认（设置里没配就是 `auto`）。 */
  shell: terminalShellSchema.optional(),
});

/** `GET /api/code/shells`：本机可用的 shell + 工作区设置的默认值（设置页与终端下拉共用）。 */
export const codeShellsResponseSchema = z.object({
  shells: z.array(
    z.object({
      id: terminalShellSchema,
      label: z.string(),
      /** 解析到的可执行文件路径（同名 shell 用它分辨）。 */
      executable: z.string(),
    }),
  ),
  defaultShell: terminalShellSchema,
  /** `defaultShell` 是 `auto` 时，这台机器上实际会用的那个 shell（界面据此说清「auto → cmd」）。 */
  resolvedShell: terminalShellSchema,
});

export const codeTerminalResponseSchema = z.object({
  result: z.object({
    command: z.string(),
    /** 实际执行这条命令的 shell（`auto` 也会解析成具体的那个）。 */
    shell: terminalShellSchema,
    /** 被超时杀掉时为 null。 */
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    /** 任一流被截断（超出每次执行的输出上限）。 */
    truncated: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  }),
});

// --- agent 运行活动（Git 弹层的「智能体 N 秒 · M 运行」；口径：近 7 天） ---

export const agentRunActivityResponseSchema = z.object({
  activity: z.object({
    /** 统计窗口（天）。 */
    windowDays: z.number().int().min(1).max(90),
    /** 窗口内该工作目录的 agent 运行次数。 */
    runs: z.number().int().nonnegative(),
    /** 窗口内各轮运行时长之和（秒）；仍在跑的轮按「到现在」计。 */
    totalSeconds: z.number().int().nonnegative(),
  }),
});

/** 工作目录里的项目文档（R3-3「文档入口」）。 */
export const codeDocsResponseSchema = z.object({
  docs: z.array(
    z.object({
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});

export const codeGitFileResponseSchema = z.object({
  file: z.object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    binary: z.boolean(),
    /** 二进制文件不回内容（空串）。 */
    content: z.string(),
  }),
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

/**
 * PUT 的入参是**部分更新**：只写送来的字段，没送的保持库里现值。
 *
 * 用整对象会踩坑：`terminalShell` 这类字段带 zod 默认值，客户端只想改模型时不会带它，
 * 服务端按「整对象写入」就会把它顺手重置成默认——这正违反「逐列 upsert，两个设置各自保存
 * 不互相覆盖」的既有口径。
 */
export const workspaceSettingsUpdateRequestSchema =
  workspaceSettingsSchema.partial();

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
