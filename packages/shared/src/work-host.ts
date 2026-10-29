import { z } from "zod";

/**
 * work 宿主适配层契约（W1：扩展包注册表 + 能力探针）。
 *
 * 定位（FORM-11 同 flow 分工，《work 模式集成规划》）：
 * - `plugins/work` = 产品入口：安装态决定工作台是否出现 Work 模式（前端按
 *   `GET /api/plugins` 的 bundle 名 + `GET /api/work/host/status` 共同门控）；
 * - `apps/server/src/features/work/` = 宿主适配层：编辑器扩展包注册表与数据目录事实；
 * - 编辑器二进制不随安装包分发（WD-3），按需下载后落位数据目录（WD-5 两档内嵌）。
 *
 * 入口纪律：插件未安装或适配层未配齐时，工作台不出现 Work 入口（不摆空壳）。
 */

/** work 插件（`plugins/work`）的 bundle 名：市场清单与前端门控只有这一处权威。 */
export const WORK_PLUGIN_BUNDLE_NAME = "kenfutwork-work";

/** 编辑器类别（用户口径：Work = 办公 + 生产力创作）。 */
export const workEditorCategorySchema = z.enum([
  "office",
  "image",
  "video",
  "layout",
  "pdf",
  "audio",
  "cad",
  /** 电子设计（原理图 / PCB）：KiCad 一档，原生窗口挂载。 */
  "eda",
]);
export type WorkEditorCategory = z.infer<typeof workEditorCategorySchema>;

/** 编辑器挂载点（WD-5 两档）：WASM iframe 为默认档，原生窗口为桌面增强档。 */
export const workEditorMountSchema = z.enum(["wasm-iframe", "native-window"]);
export type WorkEditorMount = z.infer<typeof workEditorMountSchema>;

/**
 * 锚定的上游发布（WD-3：扩展包锚定具体发布 + 校验和，升级走回归）。
 * `url` 指向 GitHub release 的 `<id>-web-<version>.zip`；`sha256` 来自同发布的
 * SHA256SUMS.txt（2026-10-25 实测核对）。
 */
export const workEditorPinnedReleaseSchema = z.object({
  version: z.string().min(1).max(32),
  /** 发行包内 web zip 资产名。 */
  asset: z.string().min(1).max(128),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().url(),
});
export type WorkEditorPinnedRelease = z.infer<
  typeof workEditorPinnedReleaseSchema
>;

/**
 * 编辑器扩展包注册项（`pinned` 非空的编辑器才提供按需下载——未锚定发布的
 * 如实显示「未锚定」，不给下载按钮，不摆假开关）。
 * `installed` 由服务端按扩展包在数据目录的落位事实计算，注册表常量本身不含它。
 */
export const workEditorSchema = z.object({
  id: z.string().min(1).max(64),
  /** 界面用名（标签口径，只写标签）。 */
  title: z.string().min(1).max(64),
  category: workEditorCategorySchema,
  /** 上游仓库（storytold/ArtCraft 系列；版本与资产以各上游为准）。 */
  repo: z.string().url(),
  /** 上游 SPDX 许可证表达式（ArtCraft 系列为 MIT OR Apache-2.0 双许可）。 */
  license: z.string().min(1).max(64),
  /** 默认挂载点（W2 全部 wasm-iframe；原生档随 W3 平台矩阵接通）。 */
  mount: workEditorMountSchema,
  /** 锚定发布；null = 尚未锚定（不提供下载）。 */
  pinned: workEditorPinnedReleaseSchema.nullable(),
  /** 扩展包是否已落位本机数据目录（下载器或手动放置都算；未落位如实回答）。 */
  installed: z.boolean(),
});
export type WorkEditor = z.infer<typeof workEditorSchema>;

/** 编辑器扩展包安装状态（同 flow 引擎安装状态机枚举；重启后归零由调用方重探）。 */
export const workEditorInstallStatusSchema = z.object({
  state: z.enum(["idle", "installing", "ready", "error"]),
  logTail: z.array(z.string()),
  error: z.string().optional(),
  startedAt: z.string().optional(),
});
export type WorkEditorInstallStatus = z.infer<
  typeof workEditorInstallStatusSchema
>;

/**
 * `GET /api/work/host/status`：宿主适配层能力探针（本机接入验证）。
 * 适配层自包含（注册表 + 数据目录），启用不依赖外部引擎；缺项写进 `reasons`
 * 由界面如实透出（fail loud，不放假开关）。
 */
export const workHostStatusResponseSchema = z.object({
  enabled: z.boolean(),
  /** 已登记的编辑器扩展包数量（探针附带的注册表事实）。 */
  registeredEditors: z.number().int().min(0),
  /** 未启用时缺什么（每条一句可读原因）；启用后为空数组。 */
  reasons: z.array(z.string()),
});
export type WorkHostStatusResponse = z.infer<
  typeof workHostStatusResponseSchema
>;

/** `GET /api/work/host/editors`：Work 引擎信息页一次取全（注册表 + 数据目录 + 安装状态）。 */
export const workHostEditorsResponseSchema = z.object({
  editors: z.array(workEditorSchema),
  /** 扩展包数据目录（下载落位与 LICENSE/NOTICE 随附位置；绝对路径）。 */
  dataDir: z.string().min(1),
  /** 各编辑器安装状态机快照（key = editorId；未发起的编辑器不在表内）。 */
  install: z.record(z.string(), workEditorInstallStatusSchema),
});
export type WorkHostEditorsResponse = z.infer<
  typeof workHostEditorsResponseSchema
>;

/** Work 模式入口门控（纯逻辑，接线在宿主 hook；纪律同 `resolveFlowEntry`）。 */
export type WorkEntry =
  | { available: true }
  | { available: false; reason: string };

export function resolveWorkEntry(input: {
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  /** 宿主适配层状态；null = 探针请求失败（按不可用处理，不猜）。 */
  status: WorkHostStatusResponse | null;
}): WorkEntry {
  if (!input.pluginInstalled) {
    return {
      available: false,
      reason: "未安装 work 插件（插件市场可安装）。",
    };
  }
  if (!input.pluginEnabled)
    return { available: false, reason: "Work 插件已停用。" };
  if (!input.status) {
    return {
      available: false,
      reason: "无法获取 work 宿主状态（/api/work/host/status 不可达）。",
    };
  }
  if (!input.status.enabled) {
    return {
      available: false,
      reason: input.status.reasons.length
        ? `宿主适配层未配齐：${input.status.reasons.join(" ")}`
        : "宿主适配层未配齐。",
    };
  }
  return { available: true };
}

/**
 * 用户字体与界面语言（Work 引擎页的「字体与语言」）。
 *
 * 为什么需要：编辑器是 WASM + WebGPU 自绘，**读不到系统字体**，只能用包内嵌的或
 * 站点同源提供的字体文件。这里让用户把自己的 ttf/otf 放进实例数据目录，宿主在
 * 托管编辑器时把它映射到站点的 `fonts/` 下——`photocraft` / `vectorcraft` 这类
 * 原生支持运行时字体的编辑器立刻可用；内嵌型编辑器仍需在构建期带上。
 *
 * 合规：上传的是**用户自己的字体**，随实例本机使用，不进仓库、不随产品分发；
 * 宋体/微软雅黑/方正系列等商业字体的授权由用户自行保证。
 */
export const workFontFormatSchema = z.enum(["ttf", "otf", "ttc"]);
export type WorkFontFormat = z.infer<typeof workFontFormatSchema>;

export const workFontSchema = z.object({
  /** 存储文件名（`<sha16>-<safe name>.<ext>`，主机内唯一、无用户可控路径）。 */
  fileName: z.string().min(1).max(160),
  /** 展示名：字体文件的家族名（解析失败时退化为文件名去扩展）。 */
  family: z.string().min(1).max(120),
  format: workFontFormatSchema,
  bytes: z.number().int().positive(),
});
export type WorkFont = z.infer<typeof workFontSchema>;

export const workFontsResponseSchema = z.object({
  /** 字体目录绝对路径（界面如实展示，便于用户自己去放文件）。 */
  dir: z.string().min(1),
  fonts: z.array(workFontSchema),
});
export type WorkFontsResponse = z.infer<typeof workFontsResponseSchema>;

/** 界面语言偏好：`auto` 跟随系统，其余为 BCP 47 码。 */
export const workUiLanguageSchema = z.string().min(1).max(32);
export type WorkUiLanguage = z.infer<typeof workUiLanguageSchema>;

export const workPreferencesSchema = z.object({
  /** `auto` 或语言码；宿主把它注入编辑器用于首次启动。 */
  language: workUiLanguageSchema,
});
export type WorkPreferences = z.infer<typeof workPreferencesSchema>;
