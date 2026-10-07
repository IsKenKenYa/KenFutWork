import { buildCuaAccessDetails as original } from "@zui-original/ToolCallBlocks/renderers/cuaAccessDetails.js";
import { readCuaResultState } from "@zui-original/ToolCallBlocks/renderers/cuaResultState.js";

/** 只适配第一方结构化状态，界面仍由原权限详情组件渲染。 */
export function buildCuaAccessDetails(
  ...args: Parameters<typeof original>
): ReturnType<typeof original> {
  const [call, format] = args;
  const result = readCuaResultState(call);
  const status = result?.permissionStatus;
  if (!status || typeof status !== "object" || Array.isArray(status))
    return original(call, format);
  const permissions = status as Record<string, unknown>;
  const projected = {
    ...result,
    accessibility: permissions.accessibility,
    screen_recording: permissions.screen,
    permission_guide: {
      all_required_granted:
        permissions.accessibility === "granted" &&
        permissions.screen === "granted" &&
        permissions.postEvents !== "denied",
    },
  };
  return original({ ...call, output: JSON.stringify(projected) }, format);
}
