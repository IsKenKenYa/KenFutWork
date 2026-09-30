/**
 * zcode 照搬：`@/ToolCallBlocks/renderers/cuaIcon.tsx`（references/zcode/packages/ui/src/ToolCallBlocks/renderers/cuaIcon.tsx）
 * 许可证：Apache-2.0（zcode）。
 * 适配注记：逐字照搬，仅 import 路径映射（手册 §2.1）。
 */
import { MousePointerClick } from "lucide-react";

export const CUA_FALLBACK_ICON = (
  <MousePointerClick className="size-4 shrink-0 text-foreground-subtle" />
);

// 兼容 CUA 分组摘要的语义名称；底层视觉仍统一使用同一个 fallback。
export const CUA_TOOL_ICON = CUA_FALLBACK_ICON;
