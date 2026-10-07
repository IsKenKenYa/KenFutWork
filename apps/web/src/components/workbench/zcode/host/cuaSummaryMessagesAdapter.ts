import { CUA_TOOL_SUMMARY_IDS as original } from "@zui-original/ToolCallBlocks/renderers/cuaSummaryMessages.js";

export const CUA_TOOL_SUMMARY_IDS: Record<string, string | undefined> = {
  ...original,
  click: original.left_click,
  drag: original.left_click_drag,
};
