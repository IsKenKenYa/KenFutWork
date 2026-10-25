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
]);
export type WorkEditorCategory = z.infer<typeof workEditorCategorySchema>;

/** 编辑器挂载点（WD-5 两档）：WASM iframe 为默认档，原生窗口为桌面增强档。 */
export const workEditorMountSchema = z.enum(["wasm-iframe", "native-window"]);
export type WorkEditorMount = z.infer<typeof workEditorMountSchema>;

/**
 * 编辑器扩展包注册项（W1 只登记元数据与挂载点；体积与校验和随 W2 下载器补齐）。
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
  /** 默认挂载点（W1 全部 wasm-iframe；原生档随 W3 平台矩阵接通）。 */
  mount: workEditorMountSchema,
  /** 扩展包是否已落位本机数据目录（未接下载器前恒 false，如实回答）。 */
  installed: z.boolean(),
});
export type WorkEditor = z.infer<typeof workEditorSchema>;

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

/** `GET /api/work/host/editors`：Work 引擎信息页一次取全（注册表 + 数据目录）。 */
export const workHostEditorsResponseSchema = z.object({
  editors: z.array(workEditorSchema),
  /** 扩展包数据目录（下载落位与 LICENSE/NOTICE 随附位置；绝对路径）。 */
  dataDir: z.string().min(1),
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
