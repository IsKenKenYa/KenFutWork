import { z } from "zod";
import {
  assetObjectSchema,
  canvasContentSchema,
  canvasDetailSchema,
  chatMessageSchema,
  chatSessionSummarySchema,
  instanceSettingsSchema,
  modelInfoSchema,
  projectKindSchema,
  projectSummarySchema,
  runIdSchema,
  terminalShellSchema,
} from "./contracts.js";
import { additionalDirectorySchema } from "./execution-contracts.js";

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("kenfutwork-server"),
  version: z.string().min(1),
});

export const runCancelResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["canceling", "canceled"]),
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
  /**
   * 本机工作目录绝对路径（Code 项目）。服务端校验「绝对路径 + 存在 + 是目录」，
   * 不合格返回 400 `invalid_work_dir` 并给出可读原因。
   */
  work_dir: z.string().trim().min(1).optional(),
  additional_directories: z.array(additionalDirectorySchema).optional(),
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
  taskId: z.string().min(1),
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
  taskId: z.string().min(1),
  message: z.string().trim().min(1).max(500),
});

export const codeGitBranchCreateRequestSchema = z.object({
  taskId: z.string().min(1),
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
  taskId: z.string().min(1),
  path: z.string().min(1).max(1000),
  staged: z.boolean(),
});

/** 暂存 / 取消暂存**一个块**（参考图审查视图的「暂存块」）。 */
export const codeGitStageHunkRequestSchema = z.object({
  taskId: z.string().min(1),
  /** 这个块属于哪个文件（服务端会核对 patch 里改的确实只有它）。 */
  path: z.string().min(1).max(1000),
  /** 「文件头 + 这一块」的 patch 文本（由审查视图从 diff 里切出来）。 */
  patch: z.string().min(1).max(200_000),
  /** true = 反向应用（索引里撤下 / 工作区里撤销）。 */
  reverse: z.boolean().optional(),
  /** `index` = 动索引（暂存/取消暂存）；`worktree` = 动工作区（撤销这一块的改动）。 */
  target: z.enum(["index", "worktree"]).optional(),
});

/** 撤销：单个文件（未跟踪的会被删掉）或全部未提交改动。 */
export const codeGitDiscardRequestSchema = z.object({
  taskId: z.string().min(1),
  /** 缺省 = 撤销全部。 */
  path: z.string().min(1).max(1000).optional(),
  /** 该文件是否未跟踪（未跟踪的撤销 = 删除文件）。 */
  untracked: z.boolean().optional(),
});

export const codeGitDiscardResponseSchema = z.object({
  ok: z.literal(true),
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
  taskId: z.string().min(1),
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

// --- 子智能体（R1-3 目录 + 设置 →「子智能体」页） ---

/**
 * `GET /api/agent/subagents`：这份清单**由 agent 装配处同一份数据导出**
 * （`apps/server/src/agent/sub-agents.ts`），不是另写一遍的说明文字——
 * 界面列出来的，就是真跑起来会用的那些。
 */
export const agentSubagentListResponseSchema = z.object({
  /** 我们声明的子代理（name 即模型分发时用的名字）。 */
  subagents: z.array(
    z.object({
      name: z.string().min(1),
      /** 中文短名（界面用；英文 description 是给模型看的）。 */
      label: z.string().min(1),
      description: z.string(),
      tools: z.array(z.string()),
    }),
  ),
  /** 框架内置的分发工具（不在我们的声明清单里，但会出现在工具表与事件流里）。 */
  builtin: z.array(
    z.object({
      name: z.string().min(1),
      label: z.string().min(1),
      description: z.string(),
    }),
  ),
});

export type AgentSubagentListResponse = z.infer<
  typeof agentSubagentListResponseSchema
>;

// --- 原生目录对话框（桌面形态：服务端在跑，对话框开在用户这台机器上） ---

/**
 * `GET /api/system/directory-picker`：这台服务端能不能弹系统文件夹对话框。
 *
 * 只有**桌面形态**可用（服务端与用户同一台机器）。自托管/Web 形态下对话框会开在
 * 服务器那台机器上、对用户毫无意义，故如实报不可用并给原因——客户端据此决定
 * 「打开文件夹」是走系统对话框，还是回落到浏览器目录选择器。
 */
export const directoryPickerStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
});

/**
 * `POST /api/system/pick-directory`：弹对话框并把选中的**绝对路径**带回来。
 *
 * 四种结果都在 200 里按 `status` 分流（HTTP 状态码表达不了「取消」与「不可用」的差别）：
 * 取消要静默、不可用要回落另一种选择器、失败要如实报原因。
 */
export const pickDirectoryResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("picked"), path: z.string().min(1) }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);

export type DirectoryPickerStatus = z.infer<typeof directoryPickerStatusSchema>;
export type PickDirectoryResponse = z.infer<typeof pickDirectoryResponseSchema>;

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
  "instance_forbidden",
  "instance_draining",
  "settings_forbidden",
  "settings_failed",
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
  // 索引库（R4-3）：两个开关各自的可读拒绝（不在枚举里 → 响应会退化成 ZodError 转储）
  "index_disabled",
  "index_not_built",
  "index_too_large",
  "index_failed",
  /**
   * 项目工作目录（`projects.work_dir`，web 形态「填本机路径」）校验失败（400）。
   * 同一个坑第二次踩到（见上面 `service_unavailable` 的注释）：码不在本枚举里，
   * `parse` 抛错后响应体变成 ZodError 转储、可读原因丢失——真机验收实测。
   */
  "invalid_work_dir",
  "session_not_found",
  "session_unavailable",
  "settings_not_found",
  "settings_update_failed",
  /** 默认模型不在目录里（保存设置时 fail loud，400；见 modelCatalog.validateSpecifier）。 */
  "invalid_model",
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
  "instance_draining",
  "marketplace_install_failed",
  "concurrency_limit",
  "generation_failed",
  // 插件市场（安装前兼容性门禁 + 启停）
  "invalid_request",
  "plugin_not_found",
  /**
   * 插件静态资源（`/api/plugins/<id>/assets/*`）里没有这个文件（404）。
   *
   * 为什么单独一个码：这个位置此前用的是 `not_found`——**不在本枚举里**（同一个坑第四次踩到，
   * 见上面 `service_unavailable` / `invalid_work_dir` 的注释）：响应体退化成 ZodError 转储，
   * 「资源不存在」被一段乱码 JSON 顶掉，真机排查时完全看不出原因（米家插件面板 404 就是这么暴露的）。
   * 服务端 `sendError` 的入参已收窄成本类型：写错码现在是编译错误。
   */
  "plugin_asset_not_found",
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
  // Code 模式检查点（影子 git）。服务内部语义码 not_found 不在枚举里（老坑见上），
  // 路由映射成 checkpoint_not_found 再进响应
  "checkpoint_not_found",
  "checkpoint_failed",
  "run_in_progress",
  // 用户侧使用统计（R4-2）
  "usage_query_failed",
  /**
   * flow 凭证缝（P3）：工作区/平台池没有启用的 dify-engine 实例（404）。
   * 与 `plugin_asset_not_found` 同一条教训——错误码必须在本枚举里，
   * 否则 `applicationErrorResponseSchema.parse` 抛错、可读原因被 ZodError 转储顶掉。
   */
  "flow_engine_not_configured",
  /** flow 凭证缝（P3）：实例在但 base_url 缺失/非法（409），凭证不下发半截。 */
  "flow_engine_invalid",
  /** flow 计费缝（P4）：hold 状态不允许该操作（无 hold / 已结算 / 已退款 / 并发修改）→ 409。 */
  "flow_billing_conflict",
  /** flow 计费缝（P4）：其余失败 → 500。 */
  "flow_billing_failed",
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

export const instanceSettingsResponseSchema = z.object({
  settings: instanceSettingsSchema,
});

/**
 * 去掉字段上的 `.default(...)`。
 *
 * `.partial()` **不会**去掉默认值：`z.boolean().default(false)` 在缺省时依然产出 `false`，
 * 于是「部分更新」的 payload 会带上一堆没送来的键（实测 `parse({codeIndexAutoNewFolder:false})`
 * 回来 6 个键）。真机复现过后果：改一个索引开关，另一个索引开关被打回默认、终端 shell 回到
 * `auto`、用户规则被清空——**一次保存静默重置其它所有设置**。
 */
/** 字段带 `.default(...)` 时取它**包着的那层**，否则原样返回。 */
type StripDefault<T> =
  T extends z.ZodDefault<infer Inner extends z.ZodTypeAny> ? Inner : T;

function withoutDefaults<T extends z.ZodRawShape>(
  shape: T,
): { [K in keyof T]: StripDefault<T[K]> } {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault ? field.removeDefault() : field,
    ]),
  ) as { [K in keyof T]: StripDefault<T[K]> };
}

/**
 * PUT 的入参是**部分更新**：只写送来的字段，没送的保持库里现值。
 *
 * 两个都不能省：① 每个字段先剥掉默认值（见 {@link withoutDefaults}）；② 再 `.partial()`
 * 让键本身可缺。少任何一个，客户端的单字段保存都会把其余设置重置成默认。
 */
export const instanceSettingsUpdateRequestSchema = z
  .object({
    ...withoutDefaults(instanceSettingsSchema.shape),
    // 响应允许未配置空值；显式选择默认模型仍必须提供非空标识。
    defaultModel: z.string().min(1),
  })
  .partial();

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
export type InstanceSettingsResponse = z.infer<
  typeof instanceSettingsResponseSchema
>;
export type InstanceSettingsUpdateRequest = z.infer<
  typeof instanceSettingsUpdateRequestSchema
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
  /** 本机工作目录绝对路径；显式 `null` = 解绑（回落到沙箱目录）。 */
  work_dir: z.string().trim().min(1).nullable().optional(),
  additional_directories: z.array(additionalDirectorySchema).optional(),
});
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
