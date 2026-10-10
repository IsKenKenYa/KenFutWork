import { CUA_TOOL_SUMMARY_IDS as original } from "@zui-original/ToolCallBlocks/renderers/cuaSummaryMessages.js";

export const CUA_TOOL_SUMMARY_IDS: Record<string, string | undefined> = {
  ...original,
  click: original.left_click,
  drag: original.left_click_drag,
  screenshot: "kenfutwork.cua.screenshot",
  focus_window: "kenfutwork.cua.focusWindow",
  list_displays: "kenfutwork.cua.listDisplays",
  list_backends: "kenfutwork.cua.listBackends",
  select_backend: "kenfutwork.cua.selectBackend",
};
