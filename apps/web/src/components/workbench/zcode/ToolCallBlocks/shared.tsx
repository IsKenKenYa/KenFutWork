/**
 * zcode 照搬：`@/ToolCallBlocks/shared.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/shared.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */

export { readRawToolCallFileSummaries } from "@zui/ToolCallBlocks/fileSummaries";
export type {
  EditKindLabelId,
  EditKindSource,
  EditOperationKind,
  RawToolCallFileSummary,
  ToolCallBlockRenderContext,
  WorkflowDraftPosition,
  WorkflowRunCardSummary,
} from "@zui/ToolCallBlocks/fileSummaryTypes";
export {
  getEditKindLabelMessageId,
  renderDiffCount,
  renderFileChip,
  renderFilePath,
  renderJoinedFileChips,
} from "@zui/ToolCallBlocks/renderers";
