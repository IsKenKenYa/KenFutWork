/**
 * zcode 照搬：`@/app-shell/workflow-artifacts/presets/index.ts`（references/zcode/packages/ui/src/app-shell/workflow-artifacts/presets/index.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1；本地 import 无 .js 后缀）；源文件自带头注保留于下。
 */
/**
 * 预置产物渲染器的公开面。
 *
 * 四个渲染器 + 两个纯函数层：
 * - `parseArtifactPresetSpec(kind, spec)` 把 wire 上的 `unknown` spec 判成「可渲染 / 不可渲染」；
 * - `applyArtifactItems(kind, spec, items)` 把 `report(item, id)` 的条目流折成视图模型；
 * - `<ArtifactChart|Table|Metrics|Board>` 渲染它，`compact` 是 run 侧板卡片里的小尺寸形态。
 *
 * **这个 barrel 的静态依赖里没有 recharts**：`ArtifactChart` 是一层 `lazy()` 封装
 * （见 `ArtifactChart.tsx`），所以 import 本模块不会把图表库拖进首屏。
 */

export { ArtifactBoard } from "@zui/app-shell/workflow-artifacts/presets/ArtifactBoard";
export { ArtifactChart } from "@zui/app-shell/workflow-artifacts/presets/ArtifactChart";
export { ArtifactMetrics } from "@zui/app-shell/workflow-artifacts/presets/ArtifactMetrics";
export { ArtifactTable } from "@zui/app-shell/workflow-artifacts/presets/ArtifactTable";
export type { ArtifactItem } from "@zui/app-shell/workflow-artifacts/presets/apply";
export type { PresetLabels } from "@zui/app-shell/workflow-artifacts/presets/parts";
export {
  type ArtifactPresetKind,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  parseArtifactPresetSpec,
  type TableSpec,
} from "@zui/app-shell/workflow-artifacts/presets/spec";
