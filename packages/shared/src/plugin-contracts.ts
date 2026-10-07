import { z } from "zod";
import {
  codeWorkDirectoryTargetSchema,
  visualWorkDirectoryTargetSchema,
} from "./execution-contracts.js";

/**
 * 插件互操作契约（HTTP + bundle 产物）。
 *
 * 设计前提：KenFutWork kernel 与 deepseek-harness（dsh）的插件接口形状同源——
 * 都是 `{ name, inject, apply(ctx) }`，差异只在**能力命名**与**组合文件**。
 * 因此一份 bundle 可以同时被两端加载，本文件即该产物的规范化定义：
 *
 * - `dshBundle`：dsh 原生格式（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）
 * - `kenfutworkBundle`：本项目格式（同名字段 + 能力绑定表）
 *
 * 兼容性判定见 `compatReportSchema`：**门禁是产品的一部分**，未通过即拒绝安装。
 */

// === 能力命名（互操作的语言） ===

/**
 * 规范能力名：以 dsh 的 ctx key 作为互操作通用语（dsh 生态更大，向其对齐成本更低）。
 * 我方 kernel 的 `ServiceKey` 是封闭联合，两者的映射表在服务端
 * `features/plugins/capability-binding.ts`（唯一属主）。
 */
export const CANONICAL_CAPABILITIES = [
  "tools",
  "settings",
  "llm",
  "sessions",
  "commands",
  "jobs",
  "systemPrompt",
  "fs",
  "subprocess",
  "sandbox",
  "agents",
  /** 本项目扩展：插件自带 HTTP 路由（`/api/plugins/<id>/…`，默认要求登录）。 */
  "routes",
  /** 本项目扩展：插件贡献 UI 面板入口（侧栏条目 + 面板渲染其 URL）。 */
  "ui",
  /**
   * 本项目扩展：插件键值存储（按工作区隔离、值加密落库）。
   *
   * 补齐「插件没有任何持久化手段」这块空白：需要跨重启存活状态的插件（第三方集成的
   * 会话凭证等）此前无路可走——门禁禁止插件直连文件系统，也不给 DB 面。
   * 工作区由调用方显式传入（路由取请求上下文、工具取执行上下文）。
   */
  "storage",
] as const;
export const canonicalCapabilitySchema = z.enum(CANONICAL_CAPABILITIES);
export type CanonicalCapability = z.infer<typeof canonicalCapabilitySchema>;

export const BUNDLE_FORMATS = ["kenfutwork", "dsh"] as const;
export const bundleFormatSchema = z.enum(BUNDLE_FORMATS);
export type BundleFormat = z.infer<typeof bundleFormatSchema>;

// === Bundle 规范化清单 ===

/**
 * 由 `package.json` + `cordis.patch.yml` 归一化得到的清单。
 * 两种来源格式都收敛到这里，后续校验/安装只看本结构。
 */
/**
 * 插件 UI 面板槽位——四个槽位各对应一处渲染位置：
 * - `sidebar`：工作台左侧栏条目（Code / Design 共用同一条侧栏）；
 * - `conversation`：对话界面（Code 的工作台对话标题行 / Design 的画布内对话面板）；
 * - `canvas`：画布页顶部栏；
 * - `settings`：设置弹窗里的「插件面板」页。
 */
export const PLUGIN_UI_SLOTS = [
  "sidebar",
  "conversation",
  "canvas",
  "settings",
] as const;
export const pluginUiSlotSchema = z.enum(PLUGIN_UI_SLOTS);
export type PluginUiSlot = z.infer<typeof pluginUiSlotSchema>;

/**
 * 插件 UI 面板入口：清单 `kenfutwork.ui` 与运行时 `ctx.ui.register` **同一形状**
 * （两处都映射到这个 schema，避免槽位集合各写一份）。
 */
export const pluginUiEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  slot: pluginUiSlotSchema.default("sidebar"),
  url: z.string().min(1),
  /**
   * 入口图标（可选，相对插件根的静态资源路径，如 `assets/icon.svg`）。
   * 宿主解析成 `/api/plugins/<id>/assets/…` 后**按单色渲染**（CSS mask，跟随菜单/卡片的文字色，
   * 与其它菜单图标同一套语言）——请提供单色线条或纯色形状的 SVG；缺省用宿主的通用图标。
   */
  icon: z.string().nullable().default(null),
});
export type PluginUiEntry = z.infer<typeof pluginUiEntrySchema>;

export const pluginBundleManifestSchema = z.object({
  /** 包名（npm 语义；也可作为插件稳定 id） */
  name: z.string().min(1),
  version: z.string().min(1),
  /** 展示名（`kenfutwork.title`，如「米家」）；缺省回落包名 */
  title: z.string().nullable().default(null),
  description: z.string().default(""),
  license: z.string().nullable().default(null),
  repositoryUrl: z.string().nullable().default(null),
  homepage: z.string().nullable().default(null),
  /** 产物格式：dsh 原生 / 本项目 */
  format: bundleFormatSchema,
  /** 配置层文件（相对包根）；dsh 为 `dsh.bundle.patch` 指向的文件 */
  patchPath: z.string().nullable().default(null),
  /** 插件模块入口（相对包根） */
  entry: z.string().nullable().default(null),
  /**
   * 插件声明所需能力（**原始名**，取自 patch 行 inject 与模块静态扫描的并集）。
   * 可能含未知名——由门禁归入不支持并给出理由，故此处不做 canonical 收窄。
   */
  requiredCapabilities: z.array(z.string()).default([]),
  /** 声明的作用域（仅本项目格式有意义） */
  scope: z.enum(["design", "code", "shared"]).nullable().default(null),
  /**
   * 市场分类（第三方插件在 package.json 的 `kenfutwork.category` 里声明；缺省归「其他」）。
   * 它只影响市场里的分组筛选，不参与能力门禁。
   */
  category: z.string().nullable().default(null),
  enginesNode: z.string().nullable().default(null),
  /** 是否携带 dsh web 客户端 UI（`dsh.client`） */
  hasClientUi: z.boolean().default(false),
  /**
   * 是否把 bundle 目录（除 node_modules）当作**静态资源**托管在
   * `/api/plugins/<id>/assets/…`（只读、限体积）。开了插件就能自带页面/样式，
   * 不必自己起 HTTP 服务。
   */
  assets: z.boolean().default(false),
  /**
   * 本项目 UI 面板入口（`kenfutwork.ui`，与 bundle 同级）：按 `slot` 出现在四处之一，
   * 点开在面板里以 iframe 渲染 `url`（通常是插件自己的路由或由本项目托管的资源）。
   */
  ui: z.array(pluginUiEntrySchema).default([]),
  /** 安装期会执行的包生命周期脚本（危险面） */
  lifecycleScripts: z.array(z.string()).default([]),
  /** 依赖的 in-box dsh bundle（`@deepseek-ai/dsh-*`），需要 dsh 运行时 */
  dshBaseDependencies: z.array(z.string()).default([]),
  /** 是否声明原生构建（binding.gyp / .node） */
  hasNativeBuild: z.boolean().default(false),
  dependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
});
export type PluginBundleManifest = z.infer<typeof pluginBundleManifestSchema>;

// === 兼容性报告（门禁输出） ===

export const COMPAT_ISSUE_CODES = [
  /** 缺 package.json 或不可解析 */
  "manifest_missing",
  /** package.json 不是合法 JSON，或缺少 name / 声明的配置层文件不存在 */
  "manifest_invalid",
  /** 既非 dsh bundle 也非本项目 bundle（无 patch 声明） */
  "bundle_declaration_missing",
  /** patch 文件缺失或不是合法 YAML 行数组 */
  "patch_invalid",
  /** 依赖 dsh in-box base bundle（`@deepseek-ai/dsh-*`）——需要 dsh 运行时 */
  "requires_dsh_runtime",
  /** 携带 dsh web 客户端 UI */
  "requires_dsh_client",
  /** 依赖我方 kernel 未提供的能力 */
  "capability_unsupported",
  /** 订阅了本内核不派发的事件（订阅也不会触发） */
  "event_unsupported",
  /** 安装期生命周期脚本会执行任意代码（需显式授权） */
  "lifecycle_script_present",
  /** 声明原生构建 */
  "native_build_required",
  /** 模块直连系统能力（child_process / worker_threads / fs 等），绕过能力面 */
  "unsafe_module_require",
  /** 使用动态属性访问上下文（`ctx[...]`），所需能力无法静态判定 */
  "dynamic_context_access",
  /** Node 引擎不满足 */
  "engines_incompatible",
  /** 声明了无法安全求值的配置表达式（dsh `!!js`） */
  "config_expression_unsupported",
  /** 未声明任何能力（纯副作用插件，无法保证行为） */
  "capability_undeclared",
] as const;
export const compatIssueCodeSchema = z.enum(COMPAT_ISSUE_CODES);
export type CompatIssueCode = z.infer<typeof compatIssueCodeSchema>;

export const compatIssueSchema = z.object({
  code: compatIssueCodeSchema,
  /** blocker 阻止安装；warning 提示但放行 */
  severity: z.enum(["blocker", "warning"]),
  message: z.string().min(1),
  detail: z.string().optional(),
});
export type CompatIssue = z.infer<typeof compatIssueSchema>;

export const compatReportSchema = z.object({
  /** 全部门禁通过才为 true；false 即拒绝安装 */
  compatible: z.boolean(),
  format: bundleFormatSchema,
  name: z.string(),
  version: z.string(),
  requiredCapabilities: z.array(canonicalCapabilitySchema),
  supportedCapabilities: z.array(canonicalCapabilitySchema),
  unsupportedCapabilities: z.array(canonicalCapabilitySchema),
  issues: z.array(compatIssueSchema),
  checkedAt: z.iso.datetime({ offset: true }),
});
export type CompatReport = z.infer<typeof compatReportSchema>;

// === 市场与已安装条目 ===

export const pluginMarketSourceSchema = z.enum(["builtin", "registry", "url"]);
export type PluginMarketSource = z.infer<typeof pluginMarketSourceSchema>;

export const pluginMarketEntrySchema = z.object({
  /** 市场条目 id：内置为插件名，第三方为 `owner/repo` */
  id: z.string().min(1),
  name: z.string().min(1),
  title: z.string(),
  description: z.string(),
  source: pluginMarketSourceSchema,
  /** 第三方条目的仓库地址 */
  repositoryUrl: z.string().nullable().default(null),
  /** 第三方条目的精确提交（安装前固定，防上游漂移） */
  headSha: z.string().nullable().default(null),
  /** 上游可安装性标注（如 skillhub 的 verified） */
  installability: z.string().nullable().default(null),
  category: z.string().nullable().default(null),
  /** 内核必需插件，不可卸载 */
  system: z.boolean().default(false),
  installed: z.boolean().default(false),
  /** 插件贡献的 UI 面板入口（仅已安装且启用时非空）。 */
  ui: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        slot: z.string().default("sidebar"),
        url: z.string().min(1),
        icon: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
export type PluginMarketEntry = z.infer<typeof pluginMarketEntrySchema>;

export const installedPluginSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  source: pluginMarketSourceSchema,
  repositoryUrl: z.string().nullable().default(null),
  /** 固定的提交；`url` 来源安装必须非空 */
  headSha: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  manifest: pluginBundleManifestSchema,
  report: compatReportSchema,
  installedAt: z.iso.datetime({ offset: true }),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

// === 请求 / 响应 ===

/** 直接填 GitHub 仓库链接安装；`ref` 为分支/tag/commit，省略时锁默认分支 HEAD。 */
export const pluginInstallRequestSchema = z.object({
  url: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
  /** 显式授权安装期生命周期脚本（默认拒绝，见门禁 lifecycle_script_present） */
  allowLifecycleScripts: z.boolean().default(false),
});
export type PluginInstallRequest = z.infer<typeof pluginInstallRequestSchema>;

/** 安装**随应用自带的 bundle**（市场里点「安装」即可，无需找来源链接）。 */
export const pluginInstallBuiltinRequestSchema = z.object({
  /** 自带 bundle 的包名（如 `kenfutwork-mihome`） */
  builtin: z.string().trim().min(1),
  allowLifecycleScripts: z.boolean().default(false),
});
export type PluginInstallBuiltinRequest = z.infer<
  typeof pluginInstallBuiltinRequestSchema
>;

/**
 * 从**沙箱工作目录**安装插件 bundle（创造模式产物的人工入口）。
 *
 * `canvasId` 决定沙箱目录（与技能/agent 同一处解析）；`path` 是相对沙箱根的
 * bundle 目录（其 package.json 需声明 kenfutwork.bundle / dsh.bundle；旧名
 * loomic.bundle 仍被接受）。服务端校验
 * 画布归属与路径不越界，不信任前端传来的路径。
 */
export const sandboxPluginInstallRequestSchema = z.union([
  codeWorkDirectoryTargetSchema.extend({ path: z.string().min(1) }),
  visualWorkDirectoryTargetSchema.extend({ path: z.string().min(1) }),
]);
export type SandboxPluginInstallRequest = z.infer<
  typeof sandboxPluginInstallRequestSchema
>;

/** 工作目录里扫到的插件 bundle 候选。 */
export const sandboxPluginBundleSchema = z.object({
  path: z.string(),
  name: z.string(),
  version: z.string(),
  declaredBy: z.enum(["kenfutwork", "dsh"]),
});
export type SandboxPluginBundle = z.infer<typeof sandboxPluginBundleSchema>;

export const sandboxPluginBundleListResponseSchema = z.object({
  bundles: z.array(sandboxPluginBundleSchema),
});
export type SandboxPluginBundleListResponse = z.infer<
  typeof sandboxPluginBundleListResponseSchema
>;

/** 导入本地/远端 bundle 目录（不安装，仅校验并返回报告）。 */
export const pluginInspectRequestSchema = z.object({
  url: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
});
export type PluginInspectRequest = z.infer<typeof pluginInspectRequestSchema>;

/** 导出的目标格式：dsh 原生 bundle 或本项目 bundle。 */
export const pluginExportRequestSchema = z.object({
  name: z.string().trim().min(1),
  format: bundleFormatSchema.default("dsh"),
});
export type PluginExportRequest = z.infer<typeof pluginExportRequestSchema>;

/** 导出产物：可直接落盘为 npm 包的文件集合。 */
export const pluginExportArtifactSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  format: bundleFormatSchema,
  /** 相对包根的文件路径 → 文本内容 */
  files: z.record(z.string(), z.string()),
  /** 该产物在目标宿主的安装命令（人类可读指引） */
  installHint: z.string(),
});
export type PluginExportArtifact = z.infer<typeof pluginExportArtifactSchema>;

export const pluginMarketListResponseSchema = z.object({
  plugins: z.array(pluginMarketEntrySchema),
});
export type PluginMarketListResponse = z.infer<
  typeof pluginMarketListResponseSchema
>;

export const pluginInspectResponseSchema = z.object({
  manifest: pluginBundleManifestSchema,
  report: compatReportSchema,
});
export type PluginInspectResponse = z.infer<typeof pluginInspectResponseSchema>;

/** 插件路由声明（`ctx.routes.register`；服务端据此把请求派发给插件）。 */
export const pluginRouteSpecSchema = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  path: z.string().min(1),
  /**
   * 是否公开（默认 false = 需要登录）。UI 面板 iframe 无法带 Authorization 头，
   * 面板页面本身通常声明 public: true，数据接口仍保持登录门。
   */
  public: z.boolean().default(false),
});
export type PluginRouteSpec = z.infer<typeof pluginRouteSpecSchema>;

export const pluginInstallResponseSchema = z.object({
  installed: installedPluginSchema,
  report: compatReportSchema,
});
export type PluginInstallResponse = z.infer<typeof pluginInstallResponseSchema>;

/**
 * 门禁拦截响应（HTTP 422）：安装被拒时**必须回传完整报告**，
 * 让用户看到是哪条判定拦下的，而不是一句笼统的「安装失败」。
 */
export const pluginIncompatibleResponseSchema = z.object({
  error: z.object({
    code: z.literal("plugin_incompatible"),
    message: z.string(),
  }),
  report: compatReportSchema,
});
export type PluginIncompatibleResponse = z.infer<
  typeof pluginIncompatibleResponseSchema
>;
