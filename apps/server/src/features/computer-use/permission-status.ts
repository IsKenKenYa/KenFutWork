/**
 * 权限状态的整理与授权主体解析（Computer Use 插件）。
 *
 * 设置页与工具结果需要同一份状态口径：
 * - 辅助功能与输入事件共用同一个系统面板，输入事件被拒时辅助功能按未授权呈现；
 * - 自动化（System Events 桥接）是独立的一项，后端能探测时必须一起返回；
 * - `pending` 表示仍有未授予项，用户可能正在系统设置里操作，模型应稍后再查而不是结束回合；
 * - `grantOwner` 是「要在系统设置里勾选的到底是哪个应用」，必须是字符串，前端缓存依赖它。
 *
 * 纯函数与进程信息分离，便于单测。
 */

export type CuPermissionState = "granted" | "denied" | "unknown";

export interface CuPermissionOwner {
  appPath: string;
  displayName: string;
}

export interface CuPermissionStatusView {
  available: true;
  platform: "darwin";
  grantOwner: string | null;
  grantOwnerDisplayName?: string;
  accessibility: CuPermissionState;
  screenRecording: CuPermissionState;
  automation: CuPermissionState;
  pending: boolean;
  reason: string;
}

function toState(
  value: "granted" | "denied" | "not_determined",
): CuPermissionState {
  return value === "granted" || value === "denied" ? value : "unknown";
}

/**
 * 从可执行文件路径取所在的应用包。打包形态是 `…/KenFutWork.app/Contents/MacOS/…`；
 * 开发形态是 node 可执行文件，没有 `.app` 段，返回 null，前端据此跳过缓存写入。
 */
export function resolveGrantOwner(
  execPath: string,
  fallbackName = "KenFutWork",
): CuPermissionOwner | null {
  if (!execPath.startsWith("/")) return null;
  const segments = execPath.split("/");
  const index = segments.findIndex((segment) => segment.endsWith(".app"));
  if (index < 0) return null;
  const appPath = segments.slice(0, index + 1).join("/");
  const appName = (segments[index] ?? "").replace(/\.app$/u, "");
  return {
    appPath,
    displayName: appName.length > 0 ? appName : fallbackName,
  };
}

export function buildPermissionStatus(input: {
  accessibility: "granted" | "denied" | "not_determined";
  screen: "granted" | "denied" | "not_determined";
  postEvents?: "granted" | "denied" | "not_determined" | undefined;
  automation?: "granted" | "denied" | "not_determined" | undefined;
  hint: string;
  owner: CuPermissionOwner | null;
}): CuPermissionStatusView {
  const accessibility =
    input.accessibility === "granted" && input.postEvents === "denied"
      ? "denied"
      : toState(input.accessibility);
  const screenRecording = toState(input.screen);
  const automation = input.automation ? toState(input.automation) : "unknown";
  return {
    available: true,
    platform: "darwin",
    grantOwner: input.owner?.appPath ?? null,
    ...(input.owner ? { grantOwnerDisplayName: input.owner.displayName } : {}),
    accessibility,
    screenRecording,
    automation,
    // 自动化探测失败（unknown）不代表缺权，不把用户挡在门外；只有明确拒绝才算未完成。
    pending:
      accessibility !== "granted" ||
      screenRecording !== "granted" ||
      automation === "denied",
    reason: input.hint,
  };
}
