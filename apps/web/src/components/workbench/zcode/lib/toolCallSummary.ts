/**
 * zcode 照搬：`@/lib/toolCallSummary.ts`（references/zcode/packages/ui/src/lib/toolCallSummary.ts）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（@zcode/shared → @zui/lib/zcode-shared，符号切片见 zcode-shared.ts）（手册 §2.1）。
 */

export type {
  CompactToolCallState,
  ToolCallChangeStat,
  ToolCallSummary,
  ToolCallSummarySource,
} from "@zui/lib/zcode-shared";
export {
  getCompactToolCallStatusMessageId,
  getCompactToolCallSummary,
  isCompactToolCallFinishedState,
  isCompactToolCallRunningState,
} from "@zui/lib/zcode-shared";
