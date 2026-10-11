import { CuaToolCallDetails as Original } from "@zui-original/ToolCallBlocks/renderers/cuaDetails.js";
import { readToolResultDisplay } from "@zui-original/ToolCallBlocks/toolResultDisplay.js";
import type { ComponentProps } from "react";
import { buildCuaScreenshotDetails } from "./cuaScreenshotDetailsAdapter.js";

/** 观察附图复用原截图详情；原卡片的动作/状态/失败信息保持原投影。 */
export function CuaToolCallDetails(props: ComponentProps<typeof Original>) {
  const display = readToolResultDisplay(props.toolCall.raw);
  const screenshot =
    props.model.success &&
    !props.model.screenshot &&
    display?.kind === "cua" &&
    display.toolName.endsWith("__get_app_state")
      ? buildCuaScreenshotDetails(props.toolCall)
      : undefined;
  return (
    <Original
      {...props}
      model={screenshot?.dataUrl ? { ...props.model, screenshot } : props.model}
    />
  );
}
